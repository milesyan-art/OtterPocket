//! Local HTTP endpoint the Chrome extension posts captures to.
//!
//! It only binds to 127.0.0.1, rejects any Host other than our own (DNS rebinding), and rejects
//! requests whose Origin is a web page, so websites cannot read or write the library.

use std::{
    io::Read,
    net::SocketAddr,
    sync::{Arc, Mutex, PoisonError},
    thread,
    time::Duration,
};

use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::{
    library::{LIBRARY_GONE, err, now},
    models::{CaptureRequest, ExtensionContact, ExtensionHello},
    setup::CurrentLibrary,
};

pub const CAPTURE_PORT: u16 = 47600;
const MAX_BODY_BYTES: u64 = 96 * 1024 * 1024;
const MAX_HELLO_BYTES: u64 = 64 * 1024;
/// How often a copy that couldn't get the port tries again.
const RETRY_EVERY: Duration = Duration::from_secs(2);

/// Emitted to the frontend, with the `CaptureResponse`, whenever the extension saves something.
pub const LIBRARY_CHANGED: &str = "library-changed";
/// Emitted to the frontend, with an `ExtensionContact`, whenever the extension gets in touch.
pub const EXTENSION_SEEN: &str = "extension-seen";
/// Emitted to the frontend, with the error or null, whenever the capture server starts or stops being able to listen.
pub const SERVER_STATUS: &str = "capture-server";

/// Why the capture server isn't listening, while it isn't, so the UI can explain why captures don't arrive.
#[derive(Default)]
pub struct ServerStatus(Mutex<Option<String>>);

impl ServerStatus {
    pub fn error(&self) -> Option<String> {
        let error = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        error.clone()
    }

    /// Records the new state and says whether it changed.
    fn set(&self, error: Option<String>) -> bool {
        let mut current = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let changed = *current != error;
        *current = error;
        changed
    }
}

/// When the extension last got in touch. Memory only: it is about this computer's Chrome, not the library.
#[derive(Default)]
pub struct ExtensionTracker(Mutex<Option<ExtensionContact>>);

impl ExtensionTracker {
    pub fn last(&self) -> Option<ExtensionContact> {
        let last = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        last.clone()
    }

    /// A capture or status request says the extension is there; only a check-in says which version.
    fn record(&self, app: &AppHandle, hello: Option<ExtensionHello>) {
        let mut last = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let hello = hello.or_else(|| last.as_ref().and_then(|c| c.hello.clone()));
        let contact = ExtensionContact { at: now(), hello };
        *last = Some(contact.clone());
        drop(last);
        let _ = app.emit(EXTENSION_SEEN, &contact);
    }
}

/// Starts the capture server on a thread of its own. When the port is taken, usually by another copy of the
/// app, it keeps trying, so this copy connects by itself as soon as the other one quits.
pub fn start(current: Arc<CurrentLibrary>, extension: Arc<ExtensionTracker>, status: Arc<ServerStatus>, app: AppHandle) {
    let address = SocketAddr::from(([127, 0, 0, 1], CAPTURE_PORT));
    // The first try happens before the window opens, so a busy port shows in the first status it reads.
    let (first, _) = try_listen(address, &status);
    let thread_status = status.clone();
    let spawned = thread::Builder::new().name("capture-server".into()).spawn(move || {
        let server = first.unwrap_or_else(|| {
            thread::sleep(RETRY_EVERY);
            listen(address, &thread_status, RETRY_EVERY, |error| {
                let _ = app.emit(SERVER_STATUS, error);
            })
        });
        for request in server.incoming_requests() {
            handle(&current, &extension, &app, request);
        }
    });
    if let Err(e) = spawned {
        status.set(Some(format!("could not start the capture server: {e}")));
    }
}

/// One try at the port. Records the outcome in `status` and says whether that changed it.
fn try_listen(address: SocketAddr, status: &ServerStatus) -> (Option<Server>, bool) {
    match Server::http(address) {
        Ok(server) => (Some(server), status.set(None)),
        Err(e) => (None, status.set(Some(format!("could not listen on {address}: {e}")))),
    }
}

/// Tries the port every `every` until it gets it, calling `changed` whenever the status changes.
fn listen(address: SocketAddr, status: &ServerStatus, every: Duration, changed: impl Fn(Option<String>)) -> Server {
    loop {
        let (server, did_change) = try_listen(address, status);
        if did_change {
            changed(status.error());
        }
        if let Some(server) = server {
            return server;
        }
        thread::sleep(every);
    }
}

fn handle(current: &CurrentLibrary, extension: &ExtensionTracker, app: &AppHandle, mut request: Request) {
    let host = header(&request, "Host");
    let origin = header(&request, "Origin");

    let allowed_hosts = [format!("127.0.0.1:{CAPTURE_PORT}"), format!("localhost:{CAPTURE_PORT}")];
    if !host.as_deref().is_some_and(|h| allowed_hosts.iter().any(|a| a == h)) {
        return respond(request, None, 403, r#"{"error":"bad host"}"#.into());
    }
    // Local tools (curl, scripts) send no Origin; browsers always send one on POST.
    let from_extension = origin.as_deref().is_some_and(|o| o.starts_with("chrome-extension://"));
    if origin.is_some() && !from_extension {
        return respond(request, None, 403, r#"{"error":"origin not allowed"}"#.into());
    }

    let cors = origin.filter(|_| from_extension);
    let method = request.method().clone();
    let path = request.url().split('?').next().unwrap_or("").to_owned();
    if method == Method::Options {
        return respond(request, cors, 204, String::new());
    }
    // The check-in works with or without a library open: it only says the extension is installed.
    if method == Method::Post && path == "/api/hello" {
        let mut raw = String::new();
        let read = request.as_reader().take(MAX_HELLO_BYTES).read_to_string(&mut raw);
        return match read.map_err(err).and_then(|_| serde_json::from_str::<ExtensionHello>(&raw).map_err(err)) {
            Err(e) => respond(request, cors, 400, error_json(&e)),
            Ok(hello) => {
                if from_extension {
                    extension.record(app, Some(hello));
                }
                let body = serde_json::json!({ "app": "otter-pocket", "version": env!("CARGO_PKG_VERSION") });
                respond(request, cors, 200, body.to_string())
            }
        };
    }
    if from_extension {
        extension.record(app, None);
    }
    // During first-run setup, or after the folder moved: 503 makes the extension keep the capture
    // in its queue and send it once a library is open.
    let library = match current.get() {
        Ok(library) if library.is_present() => library,
        Ok(_) => return respond(request, cors, 503, error_json(LIBRARY_GONE)),
        Err(_) => return respond(request, cors, 503, error_json("Otter Pocket has no library open yet. Finish setting it up in the app.")),
    };
    let (status, body) = match (method, path.as_str()) {
        (Method::Get, "/api/status") => match library.list_collections() {
            Ok(collections) => (
                200,
                serde_json::json!({
                    "app": "otter-pocket",
                    "version": env!("CARGO_PKG_VERSION"),
                    "collections": collections,
                })
                .to_string(),
            ),
            Err(e) => (500, error_json(&e)),
        },
        (Method::Post, "/api/captures") => {
            let mut raw = String::new();
            let read = request.as_reader().take(MAX_BODY_BYTES).read_to_string(&mut raw);
            match read.map_err(err).and_then(|_| serde_json::from_str::<CaptureRequest>(&raw).map_err(err)) {
                Err(e) => (400, error_json(&e)),
                Ok(capture) => match library.save_capture(capture) {
                    Ok(saved) => {
                        let _ = app.emit(LIBRARY_CHANGED, &saved);
                        (200, serde_json::to_string(&saved).unwrap_or_default())
                    }
                    Err(e) if e == LIBRARY_GONE => (503, error_json(&e)),
                    Err(e) => (400, error_json(&e)),
                },
            }
        }
        _ => (404, r#"{"error":"not found"}"#.into()),
    };
    respond(request, cors, status, body);
}

fn respond(request: Request, cors_origin: Option<String>, status: u16, body: String) {
    let mut response = Response::from_string(body).with_status_code(status);
    let mut headers = vec![("Content-Type", "application/json".to_owned())];
    if let Some(origin) = cors_origin {
        headers.extend([
            ("Access-Control-Allow-Origin", origin),
            ("Access-Control-Allow-Methods", "GET, POST, OPTIONS".into()),
            ("Access-Control-Allow-Headers", "Content-Type".into()),
            ("Access-Control-Allow-Private-Network", "true".into()),
        ]);
    }
    for (name, value) in headers {
        if let Ok(h) = Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            response.add_header(h);
        }
    }
    let _ = request.respond(response);
}

fn header(request: &Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_owned())
}

fn error_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

#[cfg(test)]
mod tests {
    use std::{net::TcpListener, sync::mpsc};

    use super::*;

    #[test]
    fn a_busy_port_is_tried_again_until_it_is_free() {
        // Another copy of the app, stood in for by a plain listener on a free port.
        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = other.local_addr().unwrap();
        let status = Arc::new(ServerStatus::default());
        let (changes, changed) = mpsc::channel();
        let waiting = status.clone();
        let listening = thread::spawn(move || {
            listen(address, &waiting, Duration::from_millis(20), move |error| changes.send(error).unwrap())
        });

        assert!(changed.recv_timeout(Duration::from_secs(5)).unwrap().is_some(), "says the port is busy");
        assert!(status.error().is_some());
        drop(other);
        assert_eq!(changed.recv_timeout(Duration::from_secs(5)).unwrap(), None, "clears it once it listens");
        let server = listening.join().unwrap();
        assert_eq!(server.server_addr().to_ip(), Some(address));
        assert_eq!(status.error(), None);
    }
}

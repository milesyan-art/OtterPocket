mod commands;
mod library;
mod lock;
mod models;
mod server;
mod setup;

use std::{borrow::Cow, sync::Arc};

use tauri::{
    Manager, RunEvent,
    http::{Request, Response, StatusCode},
};

use commands::ServerStatus;
use server::ExtensionTracker;
use setup::{CurrentLibrary, Paths, Setup};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Serves library images to the webview as lib://localhost/assets/…
        .register_uri_scheme_protocol("lib", |ctx, request| serve_asset(ctx.app_handle(), &request))
        .setup(|app| {
            // Opens the library this computer remembers; on first run there is none until setup.
            let (setup, library) = Setup::start(Paths::resolve(app.handle())?);
            let current = Arc::new(CurrentLibrary::default());
            current.replace(library.map(Arc::new));
            let extension = Arc::new(ExtensionTracker::default());
            let server_error = server::start(current.clone(), extension.clone(), app.handle().clone()).err();
            if let Some(e) = &server_error {
                eprintln!("capture server not started: {e}");
            }
            app.manage(current);
            app.manage(setup);
            app.manage(ServerStatus(server_error));
            app.manage(extension);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            setup::library_status,
            setup::setup_library,
            commands::list_collections,
            commands::create_collection,
            commands::rename_collection,
            commands::delete_collection,
            commands::list_board,
            commands::update_item_notes,
            commands::item_collections,
            commands::add_to_collection,
            commands::remove_from_collection,
            commands::save_layout,
            commands::set_board_view,
            commands::reveal_in_folder,
            commands::open_privacy_settings,
            commands::extension_contact,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // Quitting skips destructors, so close the library here: that removes library.lock and lets
        // another computer open the library straight away.
        if let RunEvent::Exit = event
            && let Some(current) = app.try_state::<Arc<CurrentLibrary>>()
        {
            drop(current.replace(None));
        }
    });
}

fn serve_asset(app: &tauri::AppHandle, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    // convertFileSrc() percent-encodes the whole path, slashes included.
    let path = request.uri().path().replace("%2F", "/").replace("%2f", "/");
    let file = app
        .try_state::<Arc<CurrentLibrary>>()
        .and_then(|current| current.get().ok())
        .and_then(|library| library.asset_path(&path))
        .and_then(|p| std::fs::read(&p).ok().map(|bytes| (p, bytes)));

    let builder = Response::builder().header("Access-Control-Allow-Origin", "*");
    match file {
        Some((p, bytes)) => builder
            .header("Content-Type", mime_for(&p))
            // Assets are content-addressed, so a given URL never changes.
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .body(Cow::Owned(bytes)),
        None => builder.status(StatusCode::NOT_FOUND).body(Cow::Borrowed(&[][..])),
    }
    .expect("static response parts are valid")
}

fn mime_for(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

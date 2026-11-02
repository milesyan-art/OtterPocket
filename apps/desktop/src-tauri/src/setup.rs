//! Where the library lives and how the app gets to it: the first-run choice, remembering the folder
//! between launches, and opening or creating a library when the user picks one.
//!
//! Only the folder's location is remembered on this computer (in the app's settings file). Everything
//! else lives inside the library folder, so on a new computer the app only needs to be shown the folder.

use std::{
    env, fs, io,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, RwLock},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::{
    library::{DB_FILE, Library, OpenOptions, OpenProblem, Result, err},
    lock::LockOwner,
    models::{LibraryInfo, LibraryStats},
    server::{CAPTURE_PORT, ServerStatus},
};

/// Folder made in Documents for a new library. Keep every name ever shipped in this list (newest
/// first): a new computer looks for all of them when it sets up.
const LIBRARY_FOLDER_NAMES: &[&str] = &["Otter Pocket"];
/// Identifiers earlier builds used (newest first). The settings folder is named after the identifier,
/// so a renamed app adopts the newest old settings file instead of asking for the library again.
const PREVIOUS_IDENTIFIERS: &[&str] = &[];
const SETTINGS_FILE: &str = "settings.json";
/// Files the system drops into folders that look empty to people.
const SYSTEM_FILES: &[&str] = &[".DS_Store", ".localized", "desktop.ini", "Thumbs.db", "Icon\r"];

/// The folders setup works with.
pub struct Paths {
    settings_file: PathBuf,
    /// Settings files of earlier app identifiers, adopted while this one has none.
    previous_settings_files: Vec<PathBuf>,
    documents: PathBuf,
    home: Option<PathBuf>,
}

impl Paths {
    /// The real locations, or all of them inside `OTTERPOCKET_SANDBOX` to rehearse first-run setup safely.
    pub fn resolve(app: &AppHandle) -> Result<Self> {
        if let Some(sandbox) = env::var_os("OTTERPOCKET_SANDBOX").map(PathBuf::from) {
            return Ok(Self {
                settings_file: sandbox.join("config").join(SETTINGS_FILE),
                previous_settings_files: Vec::new(),
                documents: sandbox.join("Documents"),
                home: Some(sandbox),
            });
        }
        let paths = app.path();
        let home = paths.home_dir().ok();
        let documents = paths.document_dir().ok().or_else(|| home.as_ref().map(|h| h.join("Documents")));
        let config_dir = paths.app_config_dir().map_err(err)?;
        let previous_settings_files = config_dir
            .parent()
            .map(|parent| PREVIOUS_IDENTIFIERS.iter().map(|id| parent.join(id).join(SETTINGS_FILE)).collect())
            .unwrap_or_default();
        Ok(Self {
            settings_file: config_dir.join(SETTINGS_FILE),
            previous_settings_files,
            documents: documents.ok_or("Otter Pocket couldn't find your Documents folder.")?,
            home,
        })
    }
}

/// What this computer remembers, in the app's config folder (not in the library).
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    /// Settings from newer versions of the app, kept so going back a version doesn't erase them.
    #[serde(flatten)]
    other: serde_json::Map<String, serde_json::Value>,
}

impl Settings {
    fn load(path: &Path) -> Self {
        let Ok(bytes) = fs::read(path) else { return Self::default() };
        serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            // Losing the remembered location is recoverable: setup asks for the folder again.
            eprintln!("ignoring unreadable {}: {e}", path.display());
            Self::default()
        })
    }

    /// This app's settings, or a copy of an earlier identifier's while this one remembers no library
    /// (none yet, or a first launch that stopped at setup): same library, and the same device ID, so
    /// locks this computer left on the library still count as its own.
    fn load_or_adopt(path: &Path, previous: &[PathBuf]) -> Self {
        let own = Self::load(path);
        if own.library_path.is_some() {
            return own;
        }
        let Some((old, settings)) =
            previous.iter().map(|old| (old, Self::load(old))).find(|(_, settings)| settings.library_path.is_some())
        else {
            return own;
        };
        // Copied, not moved, so an older build of the app keeps working.
        if let Err(e) = settings.save(path) {
            eprintln!("could not adopt {}: {e}", old.display());
        }
        settings
    }

    fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(io::Error::other)?)?;
        fs::rename(&tmp, path)
    }
}

/// The open library, if any. Commands and the capture server look it up on every call, so switching
/// libraries takes effect everywhere at once.
#[derive(Default)]
pub struct CurrentLibrary(RwLock<Option<Arc<Library>>>);

impl CurrentLibrary {
    pub fn get(&self) -> Result<Arc<Library>> {
        self.0.read().unwrap_or_else(|p| p.into_inner()).clone().ok_or_else(|| "No library is open.".into())
    }

    /// Installs `next` and returns the previous library. Dropping that closes it and removes its lock.
    pub fn replace(&self, next: Option<Arc<Library>>) -> Option<Arc<Library>> {
        std::mem::replace(&mut *self.0.write().unwrap_or_else(|p| p.into_inner()), next)
    }
}

/// A library that couldn't be opened, and where it is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryProblem {
    pub path: String,
    pub display_path: String,
    #[serde(flatten)]
    pub kind: OpenProblem,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LibraryStatus {
    Ready { library: LibraryInfo },
    /// First run (`problem` is None), or the remembered library couldn't be opened.
    Setup { problem: Option<LibraryProblem>, default_display_path: String },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SetupAction {
    /// Documents › Otter Pocket: opened if a library is already there (a synced Documents folder), else created.
    Default,
    /// Ask for a parent folder and put the library in it.
    Choose,
    /// Ask for an existing library folder.
    Open,
    /// A known library folder, to "try again" after a problem.
    Path { path: String },
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SetupResult {
    Opened { created: bool, library: LibraryInfo, stats: LibraryStats, warning: Option<String> },
    Cancelled,
    Problem { problem: LibraryProblem },
}

#[derive(Debug, PartialEq)]
enum Target {
    Open(PathBuf),
    Create(PathBuf),
}

pub struct Setup {
    paths: Paths,
    owner: LockOwner,
    /// OTTERPOCKET_LIBRARY: a library forced for development. Created if missing, never remembered.
    forced: Option<PathBuf>,
    settings: Mutex<Settings>,
    /// Why the remembered library couldn't be opened, shown instead of first-run setup.
    problem: Mutex<Option<LibraryProblem>>,
    /// One library action at a time, so a double click can't open two pickers or two libraries.
    busy: Mutex<()>,
}

impl Setup {
    /// Loads this computer's settings and opens the remembered library, if there is one.
    pub fn start(paths: Paths) -> (Self, Option<Library>) {
        let mut settings = Settings::load_or_adopt(&paths.settings_file, &paths.previous_settings_files);
        if settings.device_id.is_none() {
            settings.device_id = Some(uuid::Uuid::new_v4().to_string());
            if let Err(e) = settings.save(&paths.settings_file) {
                eprintln!("could not save settings: {e}");
            }
        }
        let owner = LockOwner { device_id: settings.device_id.clone().unwrap_or_default(), computer: computer_name() };
        let forced = env::var_os("OTTERPOCKET_LIBRARY").map(PathBuf::from);
        let remembered = forced.clone().or_else(|| settings.library_path.clone());
        let setup = Self {
            paths,
            owner,
            forced,
            settings: Mutex::new(settings),
            problem: Mutex::new(None),
            busy: Mutex::new(()),
        };

        let library = remembered.and_then(|path| {
            let options = OpenOptions { create: setup.forced.is_some(), force: false, owner: &setup.owner };
            Library::open(&path, options)
                .inspect_err(|kind| *lock(&setup.problem) = Some(setup.problem_at(&path, kind.clone())))
                .ok()
        });
        (setup, library)
    }

    pub fn status(&self, current: &CurrentLibrary, server: &ServerStatus) -> LibraryStatus {
        if let Ok(library) = current.get() {
            if library.is_present() {
                return LibraryStatus::Ready { library: self.info(&library, server) };
            }
            // Moved or deleted while the app was open: close it and ask where it went.
            current.replace(None);
            *lock(&self.problem) = Some(self.problem_at(library.root(), OpenProblem::NotFound));
        }
        // Its own statement: a guard taken inside the struct literal would live until the end of it.
        let problem = lock(&self.problem).clone();
        LibraryStatus::Setup {
            problem,
            default_display_path: self.display(&self.paths.documents.join(LIBRARY_FOLDER_NAMES[0])),
        }
    }

    /// Runs one action from the first-run screen or the library menu, and makes the result the open library.
    pub fn run(
        &self,
        app: &AppHandle,
        current: &CurrentLibrary,
        server: &ServerStatus,
        action: SetupAction,
        force: bool,
    ) -> Result<SetupResult> {
        let _busy = self.busy.try_lock().map_err(|_| "Otter Pocket is already opening a library.")?;
        let target = match action {
            SetupAction::Default => self.default_target(),
            SetupAction::Choose => match pick_folder(app, "Choose where to keep your Otter Pocket library", &self.paths.documents)? {
                Some(parent) => target_in(&parent),
                None => return Ok(SetupResult::Cancelled),
            },
            SetupAction::Open => match pick_folder(app, "Open an Otter Pocket library", &self.paths.documents)? {
                Some(folder) => Target::Open(find_library_near(&folder)),
                None => return Ok(SetupResult::Cancelled),
            },
            SetupAction::Path { path } => Target::Open(PathBuf::from(path)),
        };
        let (path, create) = match target {
            Target::Open(path) => (path, false),
            Target::Create(path) => (path, true),
        };

        // Already open: keep it (opening it again would hold the file twice).
        if let Ok(open) = current.get()
            && same_path(open.root(), &path)
        {
            let stats = open.stats().unwrap_or_default();
            return Ok(SetupResult::Opened { created: false, library: self.info(&open, server), stats, warning: None });
        }

        let library = match Library::open(&path, OpenOptions { create, force, owner: &self.owner }) {
            Ok(library) => Arc::new(library),
            Err(kind) => return Ok(SetupResult::Problem { problem: self.problem_at(&path, kind) }),
        };
        let warning = self.remember(&path).err().map(|e| {
            format!("Otter Pocket couldn't remember this location ({e}), so it will ask for your library again next time.")
        });
        let stats = library.stats().unwrap_or_default();
        let info = self.info(&library, server);
        drop(current.replace(Some(library)));
        *lock(&self.problem) = None;
        Ok(SetupResult::Opened { created: create, library: info, stats, warning })
    }

    /// Documents › Otter Pocket. A library already there wins: that's how a new computer with a synced
    /// Documents folder picks up the library without being shown where it is.
    fn default_target(&self) -> Target {
        LIBRARY_FOLDER_NAMES
            .iter()
            .map(|name| self.paths.documents.join(name))
            .find(|candidate| is_library(candidate))
            .map(Target::Open)
            .unwrap_or_else(|| target_in(&self.paths.documents))
    }

    fn remember(&self, path: &Path) -> io::Result<()> {
        if self.forced.is_some() {
            return Ok(());
        }
        let mut settings = lock(&self.settings);
        settings.library_path = Some(std::path::absolute(path)?);
        settings.save(&self.paths.settings_file)
    }

    fn info(&self, library: &Library, server: &ServerStatus) -> LibraryInfo {
        LibraryInfo {
            root: library.root().to_string_lossy().into_owned(),
            display_path: self.display(library.root()),
            capture_address: format!("127.0.0.1:{CAPTURE_PORT}"),
            server_error: server.error(),
        }
    }

    fn problem_at(&self, path: &Path, kind: OpenProblem) -> LibraryProblem {
        LibraryProblem { path: path.to_string_lossy().into_owned(), display_path: self.display(path), kind }
    }

    fn display(&self, path: &Path) -> String {
        display_path(path, self.paths.home.as_deref())
    }
}

#[tauri::command]
pub fn library_status(current: State<Arc<CurrentLibrary>>, setup: State<Setup>, server: State<Arc<ServerStatus>>) -> LibraryStatus {
    setup.status(&current, &server)
}

/// Async so the folder picker doesn't block the main thread it is drawn on.
#[tauri::command]
pub async fn setup_library(app: AppHandle, action: SetupAction, force: bool) -> Result<SetupResult> {
    let (setup, current, server) = (app.state::<Setup>(), app.state::<Arc<CurrentLibrary>>(), app.state::<Arc<ServerStatus>>());
    setup.run(&app, &current, &server, action, force)
}

fn pick_folder(app: &AppHandle, title: &str, start: &Path) -> Result<Option<PathBuf>> {
    let mut dialog = app.dialog().file().set_title(title).set_directory(start).set_can_create_directories(true);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.blocking_pick_folder().map(|picked| picked.into_path().map_err(err)).transpose()
}

/// Where a library goes in `parent`: an existing Otter Pocket library there is opened rather than
/// duplicated; otherwise the first of "Otter Pocket", "Otter Pocket 2", … that is free or empty.
fn target_in(parent: &Path) -> Target {
    if is_library(parent) {
        return Target::Open(parent.to_path_buf());
    }
    let base = LIBRARY_FOLDER_NAMES[0];
    let candidates = (1..=20).map(|n| parent.join(if n == 1 { base.to_owned() } else { format!("{base} {n}") }));
    let mut first_free = None;
    for candidate in candidates {
        if is_library(&candidate) {
            return Target::Open(candidate);
        }
        if first_free.is_none() && is_free(&candidate) {
            first_free = Some(candidate);
        }
    }
    // Nothing free (or the folder can't be read): trying the plain name reports the real reason.
    Target::Create(first_free.unwrap_or_else(|| parent.join(base)))
}

/// The library someone meant when picking `folder` in "Open an existing library": the folder itself,
/// the library around it (they picked `assets`), or the only library inside it (they picked Documents).
fn find_library_near(folder: &Path) -> PathBuf {
    if let Some(library) = folder.ancestors().take(3).find(|dir| is_library(dir)) {
        return library.to_path_buf();
    }
    let mut inside = fs::read_dir(folder).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| is_library(p));
    match (inside.next(), inside.next()) {
        (Some(only), None) => only,
        // Opening it reports what's wrong with it.
        _ => folder.to_path_buf(),
    }
}

fn is_library(dir: &Path) -> bool {
    dir.join(DB_FILE).is_file()
}

fn is_free(dir: &Path) -> bool {
    match fs::symlink_metadata(dir) {
        Err(e) => e.kind() == io::ErrorKind::NotFound,
        Ok(meta) if meta.is_dir() => fs::read_dir(dir).is_ok_and(|entries| {
            entries.flatten().all(|e| SYSTEM_FILES.contains(&e.file_name().to_string_lossy().as_ref()))
        }),
        Ok(_) => false,
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b || matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b)
}

/// "Documents › Otter Pocket" for folders in the home folder (iCloud Drive and Dropbox named the way people
/// know them), the drive name for external drives, and the full path anywhere else.
pub fn display_path(path: &Path, home: Option<&Path>) -> String {
    let relative = home.and_then(|home| path.strip_prefix(home).ok()).or_else(|| path.strip_prefix("/Volumes").ok());
    let Some(relative) = relative else { return path.display().to_string() };
    let mut parts: Vec<String> = relative
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let service = match parts.as_slice() {
        [library, docs, cloud, ..] if library == "Library" && docs == "Mobile Documents" && cloud == "com~apple~CloudDocs" => {
            Some("iCloud Drive".to_owned())
        }
        // "Dropbox", "OneDrive-Personal", "GoogleDrive-me@example.com"
        [library, storage, provider, ..] if library == "Library" && storage == "CloudStorage" => {
            Some(provider.split('-').next().unwrap_or_default().replace("GoogleDrive", "Google Drive"))
        }
        _ => None,
    };
    if let Some(service) = service {
        parts.drain(..3);
        parts.insert(0, service);
    }
    if parts.is_empty() { path.display().to_string() } else { parts.join(" › ") }
}

/// The name people know this computer by ("Alex's MacBook Pro"), shown on their other computer.
fn computer_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output()
        && out.status.success()
        && let Ok(name) = String::from_utf8(out.stdout)
        && !name.trim().is_empty()
    {
        return name.trim().to_owned();
    }
    env::var("COMPUTERNAME").or_else(|_| env::var("HOSTNAME")).unwrap_or_else(|_| "another computer".into())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = env::temp_dir().join(format!("otter-pocket-setup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_library(dir: &Path) {
        let owner = LockOwner { device_id: "d".into(), computer: "c".into() };
        drop(Library::open(dir, OpenOptions { create: true, force: false, owner: &owner }).unwrap());
    }

    #[test]
    fn new_libraries_never_mix_with_other_folders() {
        let docs = temp_dir();
        assert_eq!(target_in(&docs), Target::Create(docs.join("Otter Pocket")));

        // Someone's own "Otter Pocket" folder is left alone.
        fs::create_dir_all(docs.join("Otter Pocket")).unwrap();
        fs::write(docs.join("Otter Pocket").join("sketch.psd"), b"x").unwrap();
        assert_eq!(target_in(&docs), Target::Create(docs.join("Otter Pocket 2")));

        // An empty folder (apart from Finder's .DS_Store) can be used.
        fs::create_dir_all(docs.join("Otter Pocket 2")).unwrap();
        fs::write(docs.join("Otter Pocket 2").join(".DS_Store"), b"x").unwrap();
        assert_eq!(target_in(&docs), Target::Create(docs.join("Otter Pocket 2")));
    }

    #[test]
    fn existing_libraries_are_opened_not_duplicated() {
        let docs = temp_dir();
        fs::create_dir_all(docs.join("Otter Pocket")).unwrap();
        fs::write(docs.join("Otter Pocket").join("sketch.psd"), b"x").unwrap();
        make_library(&docs.join("Otter Pocket 2"));
        assert_eq!(target_in(&docs), Target::Open(docs.join("Otter Pocket 2")));
        assert_eq!(target_in(&docs.join("Otter Pocket 2")), Target::Open(docs.join("Otter Pocket 2")), "picked the library itself");
    }

    #[test]
    fn open_finds_the_library_people_meant() {
        let docs = temp_dir();
        let library = docs.join("Otter Pocket");
        make_library(&library);
        assert_eq!(find_library_near(&library), library);
        assert_eq!(find_library_near(&library.join("assets")), library, "picked a folder inside it");
        assert_eq!(find_library_near(&docs), library, "picked the folder around it");
        make_library(&docs.join("Other"));
        assert_eq!(find_library_near(&docs), docs, "two candidates: don't guess");
    }

    #[test]
    fn settings_keep_what_newer_versions_wrote() {
        let file = temp_dir().join("settings.json");
        fs::write(&file, r#"{"libraryPath":"/x/Otter Pocket","deviceId":"abc","theme":"light"}"#).unwrap();
        let mut settings = Settings::load(&file);
        assert_eq!(settings.library_path.as_deref(), Some(Path::new("/x/Otter Pocket")));
        settings.library_path = Some("/y/Otter Pocket".into());
        settings.save(&file).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(saved["theme"], "light");
        assert_eq!(saved["libraryPath"], "/y/Otter Pocket");

        fs::write(&file, b"{ not json").unwrap();
        assert!(Settings::load(&file).library_path.is_none(), "a broken file means asking again, not crashing");
    }

    #[test]
    fn a_renamed_app_adopts_the_old_settings() {
        let root = temp_dir();
        let old = root.join("com.example.old").join(SETTINGS_FILE);
        let new = root.join("com.example.renamed").join(SETTINGS_FILE);
        let remembered = Settings { library_path: Some("/x/Refs".into()), device_id: Some("same".into()), ..Default::default() };
        remembered.save(&old).unwrap();
        // A first launch that stopped at setup left a file with no library: that doesn't count.
        Settings { device_id: Some("fresh".into()), ..Default::default() }.save(&new).unwrap();

        let adopted = Settings::load_or_adopt(&new, std::slice::from_ref(&old));
        assert_eq!(adopted.device_id.as_deref(), Some("same"), "same device, so its library locks are still its own");
        assert_eq!(Settings::load(&new).library_path.as_deref(), Some(Path::new("/x/Refs")), "saved under the new name");
        assert!(old.is_file(), "copied, not moved");

        Settings { library_path: Some("/y".into()), ..Default::default() }.save(&new).unwrap();
        let own = Settings::load_or_adopt(&new, &[old]);
        assert_eq!(own.library_path.as_deref(), Some(Path::new("/y")), "once it has its own settings, those win");
    }

    #[test]
    fn a_library_already_in_documents_is_opened() {
        let docs = temp_dir();
        make_library(&docs.join("Otter Pocket"));
        let paths = Paths {
            settings_file: docs.join("config").join(SETTINGS_FILE),
            previous_settings_files: Vec::new(),
            documents: docs.clone(),
            home: None,
        };
        let (setup, _) = Setup::start(paths);
        assert_eq!(setup.default_target(), Target::Open(docs.join("Otter Pocket")));
    }

    #[test]
    fn paths_read_the_way_people_say_them() {
        let home = Path::new("/Users/yan");
        let show = |p: &str| display_path(Path::new(p), Some(home));
        assert_eq!(show("/Users/yan/Documents/Otter Pocket"), "Documents › Otter Pocket");
        assert_eq!(show("/Users/yan/Library/Mobile Documents/com~apple~CloudDocs/Refs/Otter Pocket"), "iCloud Drive › Refs › Otter Pocket");
        assert_eq!(show("/Users/yan/Library/CloudStorage/Dropbox/Otter Pocket"), "Dropbox › Otter Pocket");
        assert_eq!(show("/Users/yan/Library/CloudStorage/GoogleDrive-me@x.com/My Drive/Otter Pocket"), "Google Drive › My Drive › Otter Pocket");
        assert_eq!(show("/Volumes/T7/Otter Pocket"), "T7 › Otter Pocket");
        assert_eq!(show("/srv/Otter Pocket"), "/srv/Otter Pocket");
    }

    #[test]
    fn a_missing_remembered_library_is_reported_not_recreated() {
        let root = temp_dir();
        let settings_file = root.join("config").join(SETTINGS_FILE);
        let remembered = root.join("Documents").join("Otter Pocket");
        Settings { library_path: Some(remembered.clone()), ..Default::default() }.save(&settings_file).unwrap();
        let paths = Paths {
            settings_file,
            previous_settings_files: Vec::new(),
            documents: root.join("Documents"),
            home: Some(root.clone()),
        };
        let (setup, library) = Setup::start(paths);
        assert!(library.is_none());
        assert!(!remembered.exists(), "not silently recreated");

        // On another thread with a timeout, so a lock-ordering mistake fails the test instead of hanging it.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let status = setup.status(&CurrentLibrary::default(), &ServerStatus::default());
            tx.send(serde_json::to_value(status).unwrap()).unwrap();
        });
        let status = rx.recv_timeout(std::time::Duration::from_secs(5)).expect("status() answered");
        assert_eq!(status["state"], "setup");
        assert_eq!(status["problem"]["code"], "not-found");
        assert_eq!(status["problem"]["displayPath"], "Documents › Otter Pocket");
    }

    #[test]
    fn a_library_moved_while_open_is_closed_and_reported() {
        let root = temp_dir();
        let library_dir = root.join("Documents").join("Otter Pocket");
        let paths = Paths {
            settings_file: root.join("config").join(SETTINGS_FILE),
            previous_settings_files: Vec::new(),
            documents: root.join("Documents"),
            home: Some(root.clone()),
        };
        let (setup, _) = Setup::start(paths);
        let current = CurrentLibrary::default();
        let options = OpenOptions { create: true, force: false, owner: &setup.owner };
        current.replace(Some(Arc::new(Library::open(&library_dir, options).unwrap())));

        fs::rename(&library_dir, root.join("Documents").join("Elsewhere")).unwrap();
        let status = serde_json::to_value(setup.status(&current, &ServerStatus::default())).unwrap();
        assert_eq!(status["problem"]["code"], "not-found");
        assert!(current.get().is_err(), "the moved library was closed");
        assert!(!library_dir.exists(), "the old path was not recreated");
    }

    #[test]
    fn problems_reach_the_frontend_as_flat_objects() {
        let problem = LibraryProblem {
            path: "/a".into(),
            display_path: "a".into(),
            kind: OpenProblem::InUse { computer: "Studio".into(), last_seen: 5 },
        };
        let json = serde_json::to_value(&problem).unwrap();
        assert_eq!(json, serde_json::json!({ "path": "/a", "displayPath": "a", "code": "in-use", "computer": "Studio", "lastSeen": 5 }));
        let json = serde_json::to_value(LibraryProblem { kind: OpenProblem::NotALibrary, ..problem }).unwrap();
        assert_eq!(json["code"], "not-a-library");
    }
}

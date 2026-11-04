//! Tauri commands called from the React frontend (see src/api.ts).

use std::sync::Arc;

use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::{
    library::{Result, err},
    models::*,
    server::ExtensionTracker,
    setup::CurrentLibrary,
};

type Lib<'a> = State<'a, Arc<CurrentLibrary>>;

#[tauri::command]
pub fn list_collections(library: Lib) -> Result<Vec<Collection>> {
    library.get()?.list_collections()
}

#[tauri::command]
pub fn create_collection(library: Lib, name: String, kind: String, parent_id: Option<String>) -> Result<Collection> {
    library.get()?.create_collection(&name, &kind, parent_id.as_deref())
}

#[tauri::command]
pub fn rename_collection(library: Lib, id: String, name: String) -> Result<()> {
    library.get()?.rename_collection(&id, &name)
}

#[tauri::command]
pub fn delete_collection(library: Lib, id: String) -> Result<()> {
    library.get()?.delete_collection(&id)
}

#[tauri::command]
pub fn list_board(library: Lib, collection_id: String) -> Result<Vec<BoardItem>> {
    library.get()?.list_board(&collection_id)
}

#[tauri::command]
pub fn update_item_notes(library: Lib, id: String, title: Option<String>, why: Option<String>) -> Result<()> {
    library.get()?.update_item_notes(&id, title, why)
}

#[tauri::command]
pub fn item_collections(library: Lib, item_id: String) -> Result<Vec<String>> {
    library.get()?.item_collections(&item_id)
}

#[tauri::command]
pub fn add_to_collection(library: Lib, item_id: String, collection_id: String) -> Result<()> {
    library.get()?.add_to_collection(&item_id, &collection_id)
}

#[tauri::command]
pub fn remove_from_collection(library: Lib, item_id: String, collection_id: String) -> Result<()> {
    library.get()?.remove_from_collection(&item_id, &collection_id)
}

#[tauri::command]
pub fn save_layout(library: Lib, collection_id: String, updates: Vec<LayoutUpdate>) -> Result<()> {
    library.get()?.save_layout(&collection_id, &updates)
}

#[tauri::command]
pub fn set_board_view(library: Lib, collection_id: String, view: BoardView) -> Result<()> {
    library.get()?.set_board_view(&collection_id, view)
}

/// Shows the library folder (or one of its images) in Finder / Explorer.
#[tauri::command]
pub fn reveal_in_folder(app: AppHandle, library: Lib, asset: Option<String>) -> Result<()> {
    let library = library.get()?;
    let path = match asset {
        Some(asset) => library.asset_path(&asset).ok_or("That file isn't in your library.")?,
        None => library.root().to_path_buf(),
    };
    app.opener().reveal_item_in_dir(path).map_err(err)
}

#[tauri::command]
pub fn list_groups(library: Lib, collection_id: String) -> Result<Vec<Group>> {
    library.get()?.list_groups(&collection_id)
}

#[tauri::command]
pub fn save_groups(library: Lib, collection_id: String, changes: Vec<GroupChange>) -> Result<Vec<String>> {
    library.get()?.save_groups(&collection_id, &changes)
}

/// macOS: the Files & Folders privacy pane, where people let Otter Pocket into Documents.
#[tauri::command]
pub fn open_privacy_settings(app: AppHandle) -> Result<()> {
    app.opener()
        .open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders", None::<&str>)
        .map_err(err)
}

/// Shows the pointer again. After every key press the page handles, the Mac webview hides the pointer until
/// the mouse moves, so pressing Space to pan the board would make it vanish. Called just after the press.
#[tauri::command]
pub fn show_pointer(app: AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(|| objc2_app_kit::NSCursor::setHiddenUntilMouseMoves(false));
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// When the Chrome extension last got in touch, or None if it hasn't since the app started.
#[tauri::command]
pub fn extension_contact(extension: State<Arc<ExtensionTracker>>) -> Option<ExtensionContact> {
    extension.last()
}

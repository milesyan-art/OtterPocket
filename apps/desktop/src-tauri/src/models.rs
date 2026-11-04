//! Shapes shared with the frontend and the extension (see packages/shared/src/index.ts).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const ITEM_KINDS: [&str; 4] = ["image", "video_frame", "artist", "article"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub name: String,
    pub sort_order: f64,
    /// Where a project board was last looked at; None until someone pans or zooms it.
    pub view: Option<BoardView>,
}

/// A board's view: the point at the centre of the screen, in board units, and the zoom. Kept as a centre
/// rather than a corner so it comes back the same in a window of any size.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BoardView {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub page_url: String,
    pub page_title: Option<String>,
    pub site: Option<String>,
    pub favicon_url: Option<String>,
    pub media_url: Option<String>,
    pub video_time: Option<f64>,
    pub text_quote: Option<String>,
    pub origin_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureImage {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    pub target_id: String,
    pub kind: String,
    pub title: Option<String>,
    pub why: Option<String>,
    pub source: SourceInfo,
    pub image: Option<CaptureImage>,
}

/// What the extension says when it checks in (`POST /api/hello`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionHello {
    pub version: String,
    /// Chrome command name → the keys assigned to it, "" when Chrome left it unassigned (a clash).
    #[serde(default)]
    pub shortcuts: BTreeMap<String, String>,
}

/// The last time the extension got in touch, for the capture status in the sidebar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionContact {
    /// Milliseconds since the epoch.
    pub at: i64,
    /// None until the extension has checked in, e.g. when the first contact was a capture.
    pub hello: Option<ExtensionHello>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResponse {
    pub item_id: String,
    pub target_id: String,
    pub target_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub title: Option<String>,
    pub why: Option<String>,
    /// Path relative to the library root, e.g. `assets/ab/ab12….png`.
    pub asset: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub source: SourceInfo,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub z: i64,
    pub added_at: i64,
    /// The titled group it is in on this board, if any.
    #[serde(default)]
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardItem {
    pub item: Item,
    pub placement: Placement,
}

/// A titled group of references on a project board.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub title: String,
}

/// One item's placement on a board as Undo or Redo puts it back: where it was, or None for not on the board.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacementChange {
    pub item_id: String,
    pub placement: Option<Placement>,
}

/// What a group should be after `save_groups`: these items, under this title. No id makes a new group.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupChange {
    pub id: Option<String>,
    pub title: String,
    pub item_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutUpdate {
    pub item_id: String,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub z: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub root: String,
    /// How people would describe the location: "Documents › Otter Pocket".
    pub display_path: String,
    pub capture_address: String,
    /// Set while the capture server can't listen (e.g. another copy of the app owns the port); it keeps trying.
    pub server_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct LibraryStats {
    pub items: i64,
    pub projects: i64,
}

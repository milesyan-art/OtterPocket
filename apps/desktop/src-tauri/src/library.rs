//! The on-disk library: one folder holding `library.db` (SQLite) and content-addressed image files
//! under `assets/`. The folder is self-contained, so it can be copied or synced to another computer
//! and opened there; nothing about the library is kept anywhere else.
//!
//! Items exist once; collections (the Vault, projects) hold placements that point at items,
//! so the same reference can sit in the Vault and in several projects without being copied.

use std::{
    fmt::{Display, Write as _},
    fs, io,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::Engine as _;
use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension, Row, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    lock::{LockError, LockFile, LockOwner},
    models::*,
};

pub const VAULT_ID: &str = "vault";
pub const DB_FILE: &str = "library.db";
const ASSETS_DIR: &str = "assets";
const README_FILE: &str = "README.txt";

/// Marks library.db as ours in the SQLite file header. Never change it: libraries already carry it.
const APPLICATION_ID: i32 = 0x4E6E_616D;

/// Schema steps. A library's `PRAGMA user_version` counts the steps applied to it. Never change a
/// released step; append a new one. Libraries move between computers, so an app that meets a library
/// newer than it understands refuses to open it instead of guessing (`OpenProblem::TooNew`).
const MIGRATIONS: &[&str] = &[
    // 1: first release.
    "CREATE TABLE collections (
       id         TEXT PRIMARY KEY,
       parent_id  TEXT REFERENCES collections(id) ON DELETE CASCADE,
       kind       TEXT NOT NULL CHECK (kind IN ('vault', 'folder', 'project')),
       name       TEXT NOT NULL,
       sort_order REAL NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL
     );
     CREATE TABLE items (
       id          TEXT PRIMARY KEY,
       kind        TEXT NOT NULL,
       title       TEXT,
       why         TEXT,
       asset       TEXT,
       width       INTEGER,
       height      INTEGER,
       page_url    TEXT NOT NULL,
       page_title  TEXT,
       site        TEXT,
       favicon_url TEXT,
       media_url   TEXT,
       video_time  REAL,
       text_quote  TEXT,
       origin_url  TEXT,
       created_at  INTEGER NOT NULL
     );
     CREATE TABLE placements (
       collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
       item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
       x             REAL NOT NULL DEFAULT 0,
       y             REAL NOT NULL DEFAULT 0,
       scale         REAL NOT NULL DEFAULT 1,
       z             INTEGER NOT NULL DEFAULT 0,
       added_at      INTEGER NOT NULL,
       PRIMARY KEY (collection_id, item_id)
     );
     CREATE INDEX placements_by_item ON placements(item_id);
     CREATE INDEX items_by_asset ON items(asset);",
    // 2: project boards remember where they were last looked at.
    "ALTER TABLE collections ADD COLUMN view_x REAL;
     ALTER TABLE collections ADD COLUMN view_y REAL;
     ALTER TABLE collections ADD COLUMN view_zoom REAL;",
];
pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

/// Saved pages (artists and articles) are bookmark cards this wide, in board units: the page's picture on
/// top, a caption with its title and site below. Matches BOOKMARK in board/Board.ts.
const BOOKMARK_WIDTH: f64 = 1200.0;
const BOOKMARK_CAPTION: f64 = 280.0;
/// A saved page without a picture is a text card this tall.
const TEXT_CARD_HEIGHT: f64 = 600.0;
/// Pictures narrower than this (a site's icon, a profile photo) sit small in a band this tall.
const SMALL_PICTURE: f64 = 480.0;
const SMALL_PICTURE_BAND: f64 = 600.0;
/// Space kept around a new item, as a share of a typical item's shorter side: the even gap the Arrange
/// tool leaves (GAP in board/arrange.ts), so a new item sits on a tidy board the way the rest do.
const LAYOUT_GAP: f64 = 0.06;
/// A new item lines up with the edges of this many of the items nearest to where it is headed.
const LAYOUT_NEIGHBOURS: usize = 40;

pub type Result<T> = std::result::Result<T, String>;

pub fn err(e: impl Display) -> String {
    e.to_string()
}

/// Why a folder can't be opened as a library. Each one leaves the folder exactly as it was.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "code", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum OpenProblem {
    NotFound,
    NotALibrary,
    TooNew { version: i64 },
    Damaged { detail: String },
    NoPermission { detail: String },
    InUse { computer: String, last_seen: i64 },
    Other { detail: String },
}

pub struct OpenOptions<'a> {
    /// Create the folder and an empty library when there is none yet.
    pub create: bool,
    /// Open even though another computer seems to have the library open.
    pub force: bool,
    pub owner: &'a LockOwner,
}

pub struct Library {
    root: PathBuf,
    // Declared before the lock so the database is closed before library.lock is removed.
    db: Mutex<Connection>,
    _lock: LockFile,
}

impl Library {
    /// Opens the library in `root` (or creates one, with `options.create`). Everything that could make
    /// the folder unsafe to use is checked before anything in it is written.
    pub fn open(root: &Path, options: OpenOptions) -> std::result::Result<Self, OpenProblem> {
        if options.create {
            fs::create_dir_all(root).map_err(|e| io_problem(&e))?;
        }
        if !fs::metadata(root).map_err(|e| io_problem(&e))?.is_dir() {
            return Err(OpenProblem::NotALibrary);
        }
        let db_path = root.join(DB_FILE);
        match fs::metadata(&db_path) {
            // Opening for writing up front catches macOS privacy blocks and read-only folders.
            Ok(meta) if meta.is_file() => {
                fs::OpenOptions::new().read(true).write(true).open(&db_path).map_err(|e| io_problem(&e))?;
            }
            Ok(_) => return Err(OpenProblem::NotALibrary),
            Err(e) if e.kind() == io::ErrorKind::NotFound && options.create => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(OpenProblem::NotALibrary),
            Err(e) => return Err(io_problem(&e)),
        }

        let mut flags = OpenFlags::default();
        if !options.create {
            flags.remove(OpenFlags::SQLITE_OPEN_CREATE);
        }
        let mut conn = Connection::open_with_flags(&db_path, flags).map_err(sqlite_problem)?;
        conn.busy_timeout(Duration::from_secs(5)).map_err(sqlite_problem)?;

        let app_id: i32 = conn.query_row("PRAGMA application_id", [], |r| r.get(0)).map_err(sqlite_problem)?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(sqlite_problem)?;
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .and_then(|mut stmt| stmt.query_map([], |r| r.get(0))?.collect())
            .map_err(sqlite_problem)?;
        // Builds before the header was marked (application id 0) are recognised by their tables.
        let ours = app_id == APPLICATION_ID
            || (app_id == 0 && (tables.is_empty() || tables.iter().any(|t| t == "collections")));
        if !ours {
            return Err(OpenProblem::NotALibrary);
        }
        if version > SCHEMA_VERSION {
            return Err(OpenProblem::TooNew { version });
        }

        let lock = LockFile::acquire(root, options.owner, options.force).map_err(|e| match e {
            LockError::InUse { computer, last_seen } => OpenProblem::InUse { computer, last_seen },
            LockError::Io(e) => io_problem(&e),
        })?;

        // Every commit lands in library.db itself, with no -wal side file, so a copied or synced
        // folder is always complete. (Builds before this used WAL; switching is a no-op after.)
        let _ = conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get::<_, String>(0));
        conn.execute_batch("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;").map_err(sqlite_problem)?;
        migrate(&mut conn, version, app_id).map_err(sqlite_problem)?;

        fs::create_dir_all(root.join(ASSETS_DIR)).map_err(|e| io_problem(&e))?;
        write_readme(root);
        Ok(Self { root: root.to_path_buf(), db: Mutex::new(conn), _lock: lock })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// False once the folder has been moved or deleted while the library was open.
    pub fn is_present(&self) -> bool {
        self.root.join(DB_FILE).is_file()
    }

    pub fn stats(&self) -> Result<LibraryStats> {
        stats(&self.db()).map_err(err)
    }

    fn db(&self) -> MutexGuard<'_, Connection> {
        // A panic while holding the lock leaves SQLite itself consistent, so keep going.
        self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // ---- collections -------------------------------------------------------------------

    pub fn list_collections(&self) -> Result<Vec<Collection>> {
        let db = self.db();
        let mut stmt = db
            .prepare(
                "SELECT id, parent_id, kind, name, sort_order, view_x, view_y, view_zoom FROM collections
                 ORDER BY kind = 'vault' DESC, sort_order, name COLLATE NOCASE",
            )
            .map_err(err)?;
        let rows = stmt.query_map([], collection_from_row).map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    pub fn create_collection(&self, name: &str, kind: &str, parent_id: Option<&str>) -> Result<Collection> {
        if kind != "folder" && kind != "project" {
            return Err(format!("cannot create a collection of kind {kind:?}"));
        }
        let name = clean_name(name)?;
        let db = self.db();
        if let Some(parent) = parent_id {
            let parent_kind = collection_kind(&db, parent)?;
            if parent_kind.as_deref() != Some("folder") {
                return Err("projects and folders can only be nested inside folders".into());
            }
        }
        let sort_order: f64 = db
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM collections WHERE parent_id IS ?1",
                params![parent_id],
                |r| r.get(0),
            )
            .map_err(err)?;
        let id = new_id();
        db.execute(
            "INSERT INTO collections (id, parent_id, kind, name, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, parent_id, kind, name, sort_order, now()],
        )
        .map_err(err)?;
        Ok(Collection { id, parent_id: parent_id.map(str::to_owned), kind: kind.into(), name, sort_order, view: None })
    }

    pub fn rename_collection(&self, id: &str, name: &str) -> Result<()> {
        if id == VAULT_ID {
            return Err("the Vault cannot be renamed".into());
        }
        let name = clean_name(name)?;
        self.db()
            .execute("UPDATE collections SET name = ?2 WHERE id = ?1", params![id, name])
            .map_err(err)?;
        Ok(())
    }

    /// Deletes a project or folder (and everything nested in it). Items left with no placement go too.
    pub fn delete_collection(&self, id: &str) -> Result<()> {
        if id == VAULT_ID {
            return Err("the Vault cannot be deleted".into());
        }
        let db = self.db();
        db.execute("DELETE FROM collections WHERE id = ?1", params![id]).map_err(err)?;
        self.collect_orphans(&db)
    }

    // ---- items -------------------------------------------------------------------------

    pub fn save_capture(&self, req: CaptureRequest) -> Result<CaptureResponse> {
        // Writing the image would recreate the old folder path and split the library in two.
        if !self.is_present() {
            return Err(LIBRARY_GONE.into());
        }
        if !ITEM_KINDS.contains(&req.kind.as_str()) {
            return Err(format!("unknown item kind {:?}", req.kind));
        }
        if req.source.page_url.trim().is_empty() {
            return Err("source.pageUrl is required".into());
        }
        if req.image.is_none() && req.kind != "artist" && req.kind != "article" {
            return Err("image captures need image data".into());
        }

        let (asset, width, height) = match &req.image {
            Some(image) => {
                let (bytes, ext) = decode_image_data_url(&image.data_url)?;
                (Some(self.store_asset(&bytes, ext)?), Some(image.width), Some(image.height))
            }
            None => (None, None, None),
        };

        let db = self.db();
        // A project may have been deleted while a capture sat in the extension's offline queue.
        let (target_id, target_name) = match target_for_capture(&db, &req.target_id)? {
            Some(target) => target,
            None => target_for_capture(&db, VAULT_ID)?.ok_or("the Vault is missing")?,
        };

        let id = new_id();
        let s = &req.source;
        db.execute(
            "INSERT INTO items (id, kind, title, why, asset, width, height, page_url, page_title, site,
                                favicon_url, media_url, video_time, text_quote, origin_url, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                id,
                req.kind,
                non_empty(&req.title),
                non_empty(&req.why),
                asset,
                width,
                height,
                s.page_url,
                non_empty(&s.page_title),
                non_empty(&s.site),
                non_empty(&s.favicon_url),
                non_empty(&s.media_url),
                s.video_time,
                non_empty(&s.text_quote),
                non_empty(&s.origin_url),
                now(),
            ],
        )
        .map_err(err)?;
        place_item(&db, &target_id, &id)?;
        Ok(CaptureResponse { item_id: id, target_id, target_name })
    }

    pub fn list_board(&self, collection_id: &str) -> Result<Vec<BoardItem>> {
        let db = self.db();
        let mut stmt = db
            .prepare(&format!(
                "SELECT {ITEM_COLUMNS}, p.x, p.y, p.scale, p.z, p.added_at
                 FROM placements p JOIN items i ON i.id = p.item_id
                 WHERE p.collection_id = ?1
                 ORDER BY p.z"
            ))
            .map_err(err)?;
        let rows = stmt
            .query_map(params![collection_id], |r| {
                Ok(BoardItem {
                    item: item_from_row(r)?,
                    placement: Placement {
                        x: r.get(16)?,
                        y: r.get(17)?,
                        scale: r.get(18)?,
                        z: r.get(19)?,
                        added_at: r.get(20)?,
                    },
                })
            })
            .map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    pub fn update_item_notes(&self, id: &str, title: Option<String>, why: Option<String>) -> Result<()> {
        self.db()
            .execute(
                "UPDATE items SET title = ?2, why = ?3 WHERE id = ?1",
                params![id, non_empty(&title), non_empty(&why)],
            )
            .map_err(err)?;
        Ok(())
    }

    /// Ids of every collection the item is placed in.
    pub fn item_collections(&self, item_id: &str) -> Result<Vec<String>> {
        let db = self.db();
        let mut stmt = db
            .prepare("SELECT collection_id FROM placements WHERE item_id = ?1")
            .map_err(err)?;
        let rows = stmt.query_map(params![item_id], |r| r.get(0)).map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    }

    pub fn add_to_collection(&self, item_id: &str, collection_id: &str) -> Result<()> {
        let db = self.db();
        if target_for_capture(&db, collection_id)?.is_none() {
            return Err("items can only be added to the Vault or a project".into());
        }
        let already: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM placements WHERE collection_id = ?1 AND item_id = ?2)",
                params![collection_id, item_id],
                |r| r.get(0),
            )
            .map_err(err)?;
        if !already {
            place_item(&db, collection_id, item_id)?;
        }
        Ok(())
    }

    /// Takes an item off one board. When it is on no board at all, its record and file are removed.
    pub fn remove_from_collection(&self, item_id: &str, collection_id: &str) -> Result<()> {
        let db = self.db();
        db.execute(
            "DELETE FROM placements WHERE collection_id = ?1 AND item_id = ?2",
            params![collection_id, item_id],
        )
        .map_err(err)?;
        self.collect_orphans(&db)
    }

    /// Remembers where a project board was last looked at. A board that is gone is not an error: the
    /// view is saved a moment after the last pan, which can be after the board was deleted.
    pub fn set_board_view(&self, collection_id: &str, view: BoardView) -> Result<()> {
        if !(view.x.is_finite() && view.y.is_finite() && view.zoom.is_finite() && view.zoom > 0.0) {
            return Err(format!("not a board view: {view:?}"));
        }
        self.db()
            .execute(
                "UPDATE collections SET view_x = ?2, view_y = ?3, view_zoom = ?4 WHERE id = ?1 AND kind = 'project'",
                params![collection_id, view.x, view.y, view.zoom],
            )
            .map_err(err)?;
        Ok(())
    }

    pub fn save_layout(&self, collection_id: &str, updates: &[LayoutUpdate]) -> Result<()> {
        let mut db = self.db();
        let tx = db.transaction().map_err(err)?;
        {
            let mut stmt = tx
                .prepare(
                    "UPDATE placements SET x = ?3, y = ?4, scale = ?5, z = ?6
                     WHERE collection_id = ?1 AND item_id = ?2",
                )
                .map_err(err)?;
            for u in updates {
                stmt.execute(params![collection_id, u.item_id, u.x, u.y, u.scale.max(0.01), u.z])
                    .map_err(err)?;
            }
        }
        tx.commit().map_err(err)
    }

    // ---- files -------------------------------------------------------------------------

    /// Writes image bytes once per unique content; returns the path relative to the library root.
    fn store_asset(&self, bytes: &[u8], ext: &str) -> Result<String> {
        let hash = Sha256::digest(bytes).iter().fold(String::with_capacity(64), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        });
        let relative = format!("assets/{}/{hash}.{ext}", &hash[..2]);
        let path = self.root.join(&relative);
        if !path.exists() {
            fs::create_dir_all(path.parent().expect("asset path has a parent")).map_err(err)?;
            let tmp = path.with_extension(format!("{ext}.tmp"));
            fs::write(&tmp, bytes).map_err(err)?;
            fs::rename(&tmp, &path).map_err(err)?;
        }
        Ok(relative)
    }

    /// Resolves a library-relative asset path, refusing anything outside `assets/`.
    pub fn asset_path(&self, relative: &str) -> Option<PathBuf> {
        let relative = relative.trim_start_matches('/');
        let safe = relative.starts_with("assets/")
            && !relative.contains("..")
            && relative.chars().all(|c| c.is_ascii_alphanumeric() || c == '/' || c == '.');
        safe.then(|| self.root.join(relative))
    }

    fn collect_orphans(&self, db: &Connection) -> Result<()> {
        let mut stmt = db
            .prepare(
                "SELECT id, asset FROM items i
                 WHERE NOT EXISTS (SELECT 1 FROM placements p WHERE p.item_id = i.id)",
            )
            .map_err(err)?;
        let orphans: Vec<(String, Option<String>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)?;
        for (id, asset) in orphans {
            db.execute("DELETE FROM items WHERE id = ?1", params![id]).map_err(err)?;
            let Some(asset) = asset else { continue };
            let still_used: bool = db
                .query_row("SELECT EXISTS(SELECT 1 FROM items WHERE asset = ?1)", params![asset], |r| r.get(0))
                .map_err(err)?;
            if !still_used && let Some(path) = self.asset_path(&asset) {
                let _ = fs::remove_file(path);
            }
        }
        Ok(())
    }
}

const ITEM_COLUMNS: &str = "i.id, i.kind, i.title, i.why, i.asset, i.width, i.height, i.page_url, i.page_title,
     i.site, i.favicon_url, i.media_url, i.video_time, i.text_quote, i.origin_url, i.created_at";

fn item_from_row(r: &Row) -> rusqlite::Result<Item> {
    Ok(Item {
        id: r.get(0)?,
        kind: r.get(1)?,
        title: r.get(2)?,
        why: r.get(3)?,
        asset: r.get(4)?,
        width: r.get(5)?,
        height: r.get(6)?,
        source: SourceInfo {
            page_url: r.get(7)?,
            page_title: r.get(8)?,
            site: r.get(9)?,
            favicon_url: r.get(10)?,
            media_url: r.get(11)?,
            video_time: r.get(12)?,
            text_quote: r.get(13)?,
            origin_url: r.get(14)?,
        },
        created_at: r.get(15)?,
    })
}

fn collection_from_row(r: &Row) -> rusqlite::Result<Collection> {
    Ok(Collection {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        kind: r.get(2)?,
        name: r.get(3)?,
        sort_order: r.get(4)?,
        view: match (r.get(5)?, r.get(6)?, r.get(7)?) {
            (Some(x), Some(y), Some(zoom)) => Some(BoardView { x, y, zoom }),
            _ => None,
        },
    })
}

fn collection_kind(db: &Connection, id: &str) -> Result<Option<String>> {
    db.query_row("SELECT kind FROM collections WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(err)
}

/// (id, name) when `id` is a collection that can hold items: the Vault or a project.
fn target_for_capture(db: &Connection, id: &str) -> Result<Option<(String, String)>> {
    db.query_row(
        "SELECT id, name FROM collections WHERE id = ?1 AND kind IN ('vault', 'project')",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(err)
}

/// Adds an item to a board, near the middle of where the board was last looked at (see `new_spot`).
fn place_item(db: &Connection, collection_id: &str, item_id: &str) -> Result<()> {
    let size = item_size(db, item_id)?;
    let mut stmt = db
        .prepare(
            "SELECT p.x, p.y, p.scale, i.kind, i.width, i.height
             FROM placements p JOIN items i ON i.id = p.item_id WHERE p.collection_id = ?1",
        )
        .map_err(err)?;
    let boxes: Vec<Rect> = stmt
        .query_map(params![collection_id], |r| {
            let (x, y, scale): (f64, f64, f64) = (r.get(0)?, r.get(1)?, r.get(2)?);
            let kind: String = r.get(3)?;
            let (w, h) = natural_size(&kind, r.get(4)?, r.get(5)?);
            Ok(Rect { x, y, w: w * scale, h: h * scale })
        })
        .map_err(err)?
        .collect::<rusqlite::Result<_>>()
        .map_err(err)?;
    // Only project boards keep a view; the Vault is a grid, so its spots are only kept in order.
    let view: Option<(f64, f64)> = db
        .query_row("SELECT view_x, view_y FROM collections WHERE id = ?1", params![collection_id], |r| {
            Ok(match (r.get(0)?, r.get(1)?) {
                (Some(x), Some(y)) => Some((x, y)),
                _ => None,
            })
        })
        .optional()
        .map_err(err)?
        .flatten();
    let spot = new_spot(&boxes, size, view);

    let z: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(z), 0) + 1 FROM placements WHERE collection_id = ?1",
            params![collection_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    db.execute(
        "INSERT INTO placements (collection_id, item_id, x, y, scale, z, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![collection_id, item_id, spot.x, spot.y, spot.w / size.0, z, now()],
    )
    .map_err(err)?;
    Ok(())
}

/// An item's footprint on a board, in board units, as shown (scale applied).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Rect {
    fn right(&self) -> f64 {
        self.x + self.w
    }

    fn bottom(&self) -> f64 {
        self.y + self.h
    }

    /// How far `point` is from the nearest part of the box: 0 inside it.
    fn distance_to(&self, (px, py): (f64, f64)) -> f64 {
        let dx = (self.x - px).max(px - self.right()).max(0.0);
        let dy = (self.y - py).max(py - self.bottom()).max(0.0);
        dx.hypot(dy)
    }

    /// True when the two are closer than `gap` anywhere, or overlap.
    fn crowds(&self, other: &Rect, gap: f64) -> bool {
        // A spot made to sit exactly `gap` away must not count as crowding through rounding.
        let gap = gap - 1e-6 * (1.0 + gap);
        self.x < other.right() + gap
            && other.x < self.right() + gap
            && self.y < other.bottom() + gap
            && other.y < self.bottom() + gap
    }
}

/// Where a new item of natural size `w`×`h` goes on a board with `boxes` on it, and how big it is there.
///
/// It aims for `view`, the middle of where the board was last looked at (the middle of what is on it when
/// it has never been looked at), and takes the free spot nearest to it: clear of every other item by the
/// board's gap, so it never hides under or over anything, and lined up with a neighbour's edges whenever
/// that keeps it close. It comes in about as big as a typical item already there, but never bigger than
/// its own pixels, so a huge screenshot doesn't bury a board of small pictures.
fn new_spot(boxes: &[Rect], (w, h): (f64, f64), view: Option<(f64, f64)>) -> Rect {
    if boxes.is_empty() {
        let (x, y) = view.map_or((0.0, 0.0), |(x, y)| (x - w / 2.0, y - h / 2.0));
        return Rect { x, y, w, h };
    }
    let typical_area = median(boxes.iter().map(|b| b.w * b.h));
    let scale = (typical_area / (w * h)).sqrt().clamp(0.01, 1.0);
    let (w, h) = (w * scale, h * scale);
    let typical = median(boxes.iter().map(|b| b.w.min(b.h)));
    let gap = typical * LAYOUT_GAP;

    let left = boxes.iter().map(|b| b.x).fold(f64::INFINITY, f64::min);
    let top = boxes.iter().map(|b| b.y).fold(f64::INFINITY, f64::min);
    let right = boxes.iter().map(Rect::right).fold(f64::NEG_INFINITY, f64::max);
    let bottom = boxes.iter().map(Rect::bottom).fold(f64::NEG_INFINITY, f64::max);
    let aim = view.unwrap_or(((left + right) / 2.0, (top + bottom) / 2.0));

    // Nearest first: the edges worth lining up with, and the items most likely to be in the way.
    let mut near: Vec<&Rect> = boxes.iter().collect();
    near.sort_by(|a, b| a.distance_to(aim).total_cmp(&b.distance_to(aim)));

    // Each way to place the left edge and the top edge, and whether it lines up with something.
    let mut xs = vec![(aim.0 - w / 2.0, false)];
    let mut ys = vec![(aim.1 - h / 2.0, false)];
    for b in near.iter().take(LAYOUT_NEIGHBOURS) {
        xs.extend([b.right() + gap, b.x - gap - w, b.x, b.right() - w].map(|x| (x, true)));
        ys.extend([b.bottom() + gap, b.y - gap - h, b.y, b.bottom() - h].map(|y| (y, true)));
    }
    let mut spots: Vec<(f64, f64, bool, bool)> = xs
        .iter()
        .flat_map(|&(x, x_lined)| ys.iter().map(move |&(y, y_lined)| (x, y, x_lined, y_lined)))
        .collect();
    // Beside the whole board, facing the aim: always clear, however full the middle is.
    spots.extend([
        (aim.0 - w / 2.0, bottom + gap, false, true),
        (aim.0 - w / 2.0, top - gap - h, false, true),
        (right + gap, aim.1 - h / 2.0, true, false),
        (left - gap - w, aim.1 - h / 2.0, true, false),
    ]);

    // An edge that lines up with nothing counts as half a typical item further away, so a spot beside a
    // neighbour wins over floating free nearby, but empty space in the middle of the view still gets used.
    let cost = |&(x, y, x_lined, y_lined): &(f64, f64, bool, bool)| {
        let off = |lined: bool| if lined { 0.0 } else { typical / 2.0 };
        (x + w / 2.0 - aim.0).hypot(y + h / 2.0 - aim.1) + off(x_lined) + off(y_lined)
    };
    spots.sort_by(|a, b| cost(a).total_cmp(&cost(b)));
    spots
        .iter()
        .map(|&(x, y, ..)| Rect { x, y, w, h })
        .find(|spot| !near.iter().any(|b| spot.crowds(b, gap)))
        .unwrap_or(Rect { x: aim.0 - w / 2.0, y: bottom + gap, w, h })
}

fn median(values: impl Iterator<Item = f64>) -> f64 {
    let mut sorted: Vec<f64> = values.collect();
    sorted.sort_by(f64::total_cmp);
    sorted.get(sorted.len() / 2).copied().unwrap_or(0.0)
}

fn item_size(db: &Connection, item_id: &str) -> Result<(f64, f64)> {
    let (kind, w, h): (String, Option<f64>, Option<f64>) = db
        .query_row("SELECT kind, width, height FROM items WHERE id = ?1", params![item_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(err)?;
    Ok(natural_size(&kind, w, h))
}

/// An item's size before its placement's scale: a picture's own, or a bookmark card's. Matches itemSize in
/// board/Board.ts.
fn natural_size(kind: &str, width: Option<f64>, height: Option<f64>) -> (f64, f64) {
    let picture = match (width, height) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => Some((w, h)),
        _ => None,
    };
    match picture {
        Some(size) if kind != "artist" && kind != "article" => size,
        Some((w, h)) => (BOOKMARK_WIDTH, bookmark_picture_height(w, h) + BOOKMARK_CAPTION),
        None => (BOOKMARK_WIDTH, TEXT_CARD_HEIGHT),
    }
}

/// A bookmark's picture keeps its own shape, between 2:1 and 4:5, at the card's width; a small one gets a
/// fixed band. Matches bookmarkPictureHeight in board/Board.ts.
fn bookmark_picture_height(width: f64, height: f64) -> f64 {
    if width < SMALL_PICTURE {
        SMALL_PICTURE_BAND
    } else {
        BOOKMARK_WIDTH * (height / width).clamp(0.5, 1.25)
    }
}

/// `data:image/png;base64,...` -> (bytes, file extension)
fn decode_image_data_url(data_url: &str) -> Result<(Vec<u8>, &'static str)> {
    let rest = data_url.strip_prefix("data:").ok_or("image must be a data: URL")?;
    let (meta, payload) = rest.split_once(',').ok_or("malformed data: URL")?;
    let mime = meta.strip_suffix(";base64").ok_or("image data must be base64")?;
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        other => return Err(format!("unsupported image type {other:?}")),
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(payload).map_err(err)?;
    if bytes.is_empty() {
        return Err("image data is empty".into());
    }
    Ok((bytes, ext))
}

/// Brings the schema from `version` up to date, one transaction per step, so a crash or a full disk
/// mid-way leaves the library at the last complete step.
fn migrate(conn: &mut Connection, version: i64, app_id: i32) -> rusqlite::Result<()> {
    for (step, sql) in MIGRATIONS.iter().enumerate().skip(version.max(0) as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", step as i64 + 1)?;
        tx.commit()?;
    }
    let tx = conn.transaction()?;
    if app_id != APPLICATION_ID {
        tx.pragma_update(None, "application_id", APPLICATION_ID)?;
    }
    // Also repairs libraries from early builds that could crash between creating tables and the Vault.
    tx.execute(
        "INSERT OR IGNORE INTO collections (id, parent_id, kind, name, sort_order, created_at)
         VALUES (?1, NULL, 'vault', 'Vault', 0, ?2)",
        params![VAULT_ID, now()],
    )?;
    tx.commit()
}

fn stats(db: &Connection) -> rusqlite::Result<LibraryStats> {
    db.query_row(
        "SELECT (SELECT COUNT(*) FROM items), (SELECT COUNT(*) FROM collections WHERE kind = 'project')",
        [],
        |r| Ok(LibraryStats { items: r.get(0)?, projects: r.get(1)? }),
    )
}

/// Error for captures that arrive after the library folder was moved or deleted under the open app.
pub const LIBRARY_GONE: &str = "Your library folder was moved or deleted. Open Otter Pocket to find it again.";

fn io_problem(e: &io::Error) -> OpenProblem {
    match e.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => OpenProblem::NotFound,
        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem => {
            OpenProblem::NoPermission { detail: e.to_string() }
        }
        _ => OpenProblem::Other { detail: e.to_string() },
    }
}

fn sqlite_problem(e: rusqlite::Error) -> OpenProblem {
    match e.sqlite_error_code() {
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => OpenProblem::Damaged { detail: e.to_string() },
        Some(ErrorCode::ReadOnly | ErrorCode::PermissionDenied | ErrorCode::CannotOpen) => {
            OpenProblem::NoPermission { detail: e.to_string() }
        }
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => OpenProblem::Other {
            detail: "Another program is using library.db. Close it and try again.".into(),
        },
        _ => OpenProblem::Other { detail: e.to_string() },
    }
}

/// A note for anyone who opens the folder, written once (people may edit or delete it).
fn write_readme(root: &Path) {
    let path = root.join(README_FILE);
    if !path.exists() {
        let _ = fs::write(path, README);
    }
}

const README: &str = "\
This folder is your Otter Pocket library.

Everything Otter Pocket keeps is in here:
  library.db     your boards, notes, and the link back to where each reference came from
  assets         your saved images
  library.lock   only there while Otter Pocket has this library open

To use your library on another computer:
  1. Quit Otter Pocket.
  2. Copy this whole folder to the other computer, or keep it in iCloud Drive or Dropbox.
  3. Install Otter Pocket there, choose \"Open an existing library\", and pick this folder.

Back up this folder like any other. Please don't rename or edit the files inside,
and don't use the same library on two computers at the same time.
";

fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name cannot be empty".into());
    }
    Ok(name.chars().take(200).collect())
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Milliseconds since the Unix epoch.
pub(crate) fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PIXEL_PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    fn owner() -> LockOwner {
        LockOwner { device_id: "this-device".into(), computer: "Test Mac".into() }
    }

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("otter-pocket-test-{name}-{}", new_id()))
    }

    fn open(root: &Path, create: bool) -> std::result::Result<Library, OpenProblem> {
        Library::open(root, OpenOptions { create, force: false, owner: &owner() })
    }

    fn temp_library(name: &str) -> Library {
        open(&temp_dir(name), true).unwrap()
    }

    /// A library.db someone else made, with the given header values.
    fn raw_db(root: &Path, setup_sql: &str) {
        fs::create_dir_all(root).unwrap();
        Connection::open(root.join(DB_FILE)).unwrap().execute_batch(setup_sql).unwrap();
    }

    fn capture(target: &str, kind: &str, with_image: bool) -> CaptureRequest {
        CaptureRequest {
            target_id: target.into(),
            kind: kind.into(),
            title: Some("  ".into()),
            why: Some("the grainy light".into()),
            source: SourceInfo { page_url: "https://example.com/a".into(), ..Default::default() },
            image: with_image.then(|| CaptureImage { data_url: PIXEL_PNG.into(), width: 1, height: 1 }),
        }
    }

    #[test]
    fn capture_to_vault_stores_file_and_metadata() {
        let lib = temp_library("vault");
        let res = lib.save_capture(capture(VAULT_ID, "image", true)).unwrap();
        assert_eq!(res.target_name, "Vault");
        let board = lib.list_board(VAULT_ID).unwrap();
        assert_eq!(board.len(), 1);
        let item = &board[0].item;
        assert_eq!(item.title, None, "blank strings are stored as NULL");
        assert_eq!(item.why.as_deref(), Some("the grainy light"));
        let path = lib.asset_path(item.asset.as_ref().unwrap()).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn unknown_target_falls_back_to_vault() {
        let lib = temp_library("fallback");
        let res = lib.save_capture(capture("deleted-project", "artist", false)).unwrap();
        assert_eq!(res.target_id, VAULT_ID);
    }

    #[test]
    fn same_item_on_two_boards_and_cleanup() {
        let lib = temp_library("boards");
        let project = lib.create_collection("Forest camp", "project", None).unwrap();
        let res = lib.save_capture(capture(&project.id, "image", true)).unwrap();
        lib.add_to_collection(&res.item_id, VAULT_ID).unwrap();
        let mut ids = lib.item_collections(&res.item_id).unwrap();
        ids.sort();
        let mut expected = vec![project.id.clone(), VAULT_ID.to_string()];
        expected.sort();
        assert_eq!(ids, expected);

        let asset = lib.list_board(VAULT_ID).unwrap()[0].item.asset.clone().unwrap();
        lib.delete_collection(&project.id).unwrap();
        assert_eq!(lib.list_board(VAULT_ID).unwrap().len(), 1, "still in the Vault");
        lib.remove_from_collection(&res.item_id, VAULT_ID).unwrap();
        assert!(lib.list_board(VAULT_ID).unwrap().is_empty());
        assert!(!lib.asset_path(&asset).unwrap().exists(), "file removed with the last placement");
    }

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn new_items_land_where_the_board_was_last_looked_at() {
        let lib = temp_library("layout");
        let project = lib.create_collection("P", "project", None).unwrap();
        lib.save_capture(capture(&project.id, "artist", false)).unwrap();
        lib.save_capture(capture(&project.id, "article", false)).unwrap();
        let board = lib.list_board(&project.id).unwrap();
        let first = &board[0].placement;
        assert_eq!((first.x, first.y, first.scale), (0.0, 0.0, 1.0));
        let card = (BOOKMARK_WIDTH, TEXT_CARD_HEIGHT);
        let gap = card.1 * LAYOUT_GAP;
        let second = &board[1].placement;
        assert_eq!((second.x, second.y), (0.0, card.1 + gap), "right next to the first, lined up with it");

        lib.set_board_view(&project.id, BoardView { x: 5000.0, y: 3000.0, zoom: 0.5 }).unwrap();
        let res = lib.save_capture(capture(&project.id, "artist", false)).unwrap();
        let board = lib.list_board(&project.id).unwrap();
        let third = &board.iter().find(|b| b.item.id == res.item_id).unwrap().placement;
        assert_eq!((third.x, third.y), (5000.0 - card.0 / 2.0, 3000.0 - card.1 / 2.0), "in the middle of the view");
    }

    #[test]
    fn saved_pages_are_bookmark_cards_with_their_picture_on_top() {
        // A page's preview picture (1200×630) is drawn at its own shape, a square one too, with the caption under it.
        assert_eq!(natural_size("article", Some(1200.0), Some(630.0)), (1200.0, 630.0 + BOOKMARK_CAPTION));
        assert_eq!(natural_size("artist", Some(2400.0), Some(2400.0)), (1200.0, 1200.0 + BOOKMARK_CAPTION));
        // Very wide or very tall pictures are cropped to 2:1 and 4:5.
        assert_eq!(natural_size("article", Some(3000.0), Some(500.0)), (1200.0, 600.0 + BOOKMARK_CAPTION));
        assert_eq!(natural_size("article", Some(1000.0), Some(3000.0)), (1200.0, 1500.0 + BOOKMARK_CAPTION));
        // A profile photo or an icon sits small in a band; no picture is a text card.
        assert_eq!(natural_size("artist", Some(150.0), Some(150.0)), (1200.0, SMALL_PICTURE_BAND + BOOKMARK_CAPTION));
        assert_eq!(natural_size("article", None, None), (1200.0, TEXT_CARD_HEIGHT));
        // Pictures saved as pictures keep their own pixels.
        assert_eq!(natural_size("image", Some(640.0), Some(480.0)), (640.0, 480.0));
    }

    #[test]
    fn new_items_line_up_with_a_neighbour_close_by() {
        let board = [rect(0.0, 0.0, 400.0, 300.0)];
        let gap = 300.0 * LAYOUT_GAP;
        assert_eq!(new_spot(&board, (400.0, 300.0), None), rect(0.0, 300.0 + gap, 400.0, 300.0));
        // Looking just past its right edge: it goes beside it, not loose a little further on.
        assert_eq!(new_spot(&board, (400.0, 300.0), Some((700.0, 150.0))), rect(400.0 + gap, 0.0, 400.0, 300.0));
        // Looking at empty space well away from it: right there.
        assert_eq!(new_spot(&board, (400.0, 300.0), Some((3000.0, 150.0))), rect(2800.0, 0.0, 400.0, 300.0));
    }

    #[test]
    fn new_items_come_in_at_a_typical_size() {
        let board = [rect(0.0, 0.0, 300.0, 300.0), rect(340.0, 0.0, 300.0, 200.0), rect(680.0, 0.0, 300.0, 300.0)];
        let huge = new_spot(&board, (3000.0, 3000.0), None);
        assert!((huge.w - 300.0).abs() < 1e-9 && (huge.h - 300.0).abs() < 1e-9, "shrunk to fit in: {huge:?}");
        let small = new_spot(&board, (100.0, 50.0), None);
        assert_eq!((small.w, small.h), (100.0, 50.0), "never blown up past its own pixels");
    }

    #[test]
    fn a_new_item_never_lands_on_another() {
        // Columns of uneven heights: the old "end of the bottom row" rule put new items
        // on top of the neighbouring column.
        let mut board = Vec::new();
        for (col, heights) in [[300.0, 180.0, 420.0], [520.0, 260.0, 140.0], [200.0, 200.0, 610.0]].iter().enumerate() {
            let mut y = 0.0;
            for h in heights {
                board.push(rect(col as f64 * 250.0, y, 236.0, *h));
                y += h + 14.0;
            }
        }
        // And a messy pile, some of it overlapping, of every size.
        let mut seed = 7_u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as f64 / (1u64 << 31) as f64
        };
        for _ in 0..60 {
            board.push(rect(next() * 4000.0 - 1500.0, next() * 3000.0, 80.0 + next() * 900.0, 80.0 + next() * 900.0));
        }
        let gap = median(board.iter().map(|b| b.w.min(b.h))) * LAYOUT_GAP;
        for _ in 0..200 {
            let aim = (next() * 5000.0 - 2000.0, next() * 4000.0 - 500.0);
            let size = (50.0 + next() * 3000.0, 50.0 + next() * 3000.0);
            let spot = new_spot(&board, size, Some(aim));
            assert!(!board.iter().any(|b| spot.crowds(b, gap)), "{spot:?} lands on something, aiming at {aim:?}");
        }
    }

    #[test]
    fn nesting_and_protection_rules() {
        let lib = temp_library("rules");
        let folder = lib.create_collection("Clients", "folder", None).unwrap();
        let project = lib.create_collection("Posters", "project", Some(&folder.id)).unwrap();
        assert!(lib.create_collection("x", "project", Some(&project.id)).is_err());
        assert!(lib.create_collection("x", "vault", None).is_err());
        assert!(lib.delete_collection(VAULT_ID).is_err());
        assert!(lib.asset_path("../library.db").is_none());
        assert!(lib.asset_path("library.db").is_none());
        lib.delete_collection(&folder.id).unwrap();
        assert_eq!(lib.list_collections().unwrap().len(), 1, "nested project deleted with its folder");
    }

    #[test]
    fn a_copied_folder_opens_with_everything_in_it() {
        let root = temp_dir("copy");
        let lib = open(&root, true).unwrap();
        let project = lib.create_collection("Forest camp", "project", None).unwrap();
        lib.save_capture(capture(&project.id, "image", true)).unwrap();
        drop(lib);
        assert!(!root.join(crate::lock::LOCK_FILE).exists(), "closing removes the lock");
        assert!(root.join(README_FILE).exists());
        let names: Vec<_> = fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert!(!names.iter().any(|n| n.to_string_lossy().ends_with("-wal")), "no side files: {names:?}");

        // "Another computer": a different folder path, a different device.
        let moved = temp_dir("moved");
        fs::rename(&root, &moved).unwrap();
        let other = LockOwner { device_id: "new-mac".into(), computer: "New Mac".into() };
        let lib = Library::open(&moved, OpenOptions { create: false, force: false, owner: &other }).unwrap();
        assert_eq!(lib.stats().unwrap(), LibraryStats { items: 1, projects: 1 });
        let item = &lib.list_board(&project.id).unwrap()[0].item;
        assert!(lib.asset_path(item.asset.as_ref().unwrap()).unwrap().exists());
    }

    #[test]
    fn boards_reopen_where_they_were_left() {
        let root = temp_dir("views");
        let lib = open(&root, true).unwrap();
        let project = lib.create_collection("Poster", "project", None).unwrap();
        let view = |lib: &Library| lib.list_collections().unwrap().into_iter().find(|c| c.id == project.id).unwrap().view;
        assert_eq!(view(&lib), None, "new boards have no view yet, so they open fitted");

        let left = BoardView { x: 412.5, y: -80.0, zoom: 2.25 };
        lib.set_board_view(&project.id, left).unwrap();
        lib.set_board_view(VAULT_ID, left).unwrap(); // the Vault is a grid: nothing to keep
        lib.set_board_view("deleted-a-moment-ago", left).unwrap();
        assert!(lib.set_board_view(&project.id, BoardView { zoom: f64::NAN, ..left }).is_err());
        drop(lib);

        let lib = open(&root, false).unwrap();
        assert_eq!(view(&lib), Some(left), "kept in the library, so it survives a restart or a new computer");
        assert_eq!(lib.list_collections().unwrap()[0].view, None);
    }

    #[test]
    fn opening_never_creates_a_library_by_accident() {
        let missing = temp_dir("missing");
        assert_eq!(open(&missing, false).err(), Some(OpenProblem::NotFound));
        assert!(!missing.exists(), "nothing created");
        let empty = temp_dir("empty");
        fs::create_dir_all(&empty).unwrap();
        assert_eq!(open(&empty, false).err(), Some(OpenProblem::NotALibrary));
        assert!(!empty.join(DB_FILE).exists());
    }

    #[test]
    fn newer_libraries_are_refused_and_left_untouched() {
        let root = temp_dir("newer");
        raw_db(&root, &format!("PRAGMA application_id = {APPLICATION_ID}; PRAGMA user_version = 99; CREATE TABLE collections (id TEXT);"));
        let before = fs::read(root.join(DB_FILE)).unwrap();
        assert_eq!(open(&root, false).err(), Some(OpenProblem::TooNew { version: 99 }));
        assert_eq!(fs::read(root.join(DB_FILE)).unwrap(), before, "not a byte changed");
        assert!(!root.join(crate::lock::LOCK_FILE).exists(), "no lock left behind");
    }

    #[test]
    fn other_files_named_library_db_are_refused() {
        let foreign = temp_dir("foreign");
        raw_db(&foreign, "PRAGMA application_id = 42; CREATE TABLE notes (id TEXT);");
        assert_eq!(open(&foreign, false).err(), Some(OpenProblem::NotALibrary));
        let unmarked = temp_dir("unmarked");
        raw_db(&unmarked, "CREATE TABLE notes (id TEXT);");
        assert_eq!(open(&unmarked, false).err(), Some(OpenProblem::NotALibrary));

        let garbage = temp_dir("garbage");
        fs::create_dir_all(&garbage).unwrap();
        fs::write(garbage.join(DB_FILE), b"definitely not a database, just some text that is long enough").unwrap();
        assert!(matches!(open(&garbage, false), Err(OpenProblem::Damaged { .. })));
    }

    #[test]
    fn libraries_from_early_builds_are_adopted_and_repaired() {
        let root = temp_dir("legacy");
        // Early builds: WAL mode, no application id, and a crash could leave out the Vault.
        raw_db(&root, &format!("PRAGMA journal_mode = WAL; {} PRAGMA user_version = 1;", MIGRATIONS[0]));
        let lib = open(&root, false).unwrap();
        assert_eq!(lib.list_collections().unwrap()[0].id, VAULT_ID, "Vault restored");
        let db = lib.db();
        let app_id: i32 = db.query_row("PRAGMA application_id", [], |r| r.get(0)).unwrap();
        let mode: String = db.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!((app_id, mode.as_str()), (APPLICATION_ID, "delete"));
    }

    #[test]
    fn a_library_open_on_another_computer_needs_confirmation() {
        let root = temp_dir("in-use");
        let elsewhere = LockOwner { device_id: "studio".into(), computer: "Studio iMac".into() };
        let held = Library::open(&root, OpenOptions { create: true, force: false, owner: &elsewhere }).unwrap();
        assert!(matches!(open(&root, false), Err(OpenProblem::InUse { ref computer, .. }) if computer == "Studio iMac"));
        let forced = Library::open(&root, OpenOptions { create: false, force: true, owner: &owner() });
        assert!(forced.is_ok());
        drop(held);
    }

    #[test]
    fn captures_stop_when_the_folder_disappears() {
        let root = temp_dir("gone");
        let lib = open(&root, true).unwrap();
        fs::rename(&root, temp_dir("gone-moved")).unwrap();
        assert!(!lib.is_present());
        assert_eq!(lib.save_capture(capture(VAULT_ID, "image", true)).err().as_deref(), Some(LIBRARY_GONE));
        assert!(!root.exists(), "the old path was not recreated");
    }
}

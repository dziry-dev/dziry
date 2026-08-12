//! Decoded images, and which node each belongs to.
//!
//! # Why the bytes arrive over FFI rather than the tables
//!
//! The shared tables carry what the compiler knows: *that* this node is an image
//! and where its bytes come from. The bytes themselves are different in kind —
//! a megabyte of PNG is not a struct-of-arrays row — and resolving them is I/O,
//! which is the host's job on both axes: `fetch` and the filesystem are Bun's,
//! and the engine stays a library that never touches a socket. So the table
//! holds `(node, src)` and the host calls [`Images::provide`] with the decoded
//! candidate, exactly as it hands user keystrokes over rather than the engine
//! reading the keyboard itself.
//!
//! # Why the cache is keyed by `src` and not by row
//!
//! Bun republishes the whole table whenever any signal changes, so row identity
//! is cheap to remake and worth nothing as a key — a cache keyed by it would
//! re-decode every image on every unrelated counter tick. The `src` string is
//! the stable fact: two `<img>`s sharing a URL decode once, and a republished
//! table finds its bitmaps already warm. This is the same split `Controls`
//! makes between a sparse table and dense state, one level further.
//!
//! # What a failed decode is
//!
//! `Failed`, cached like `Ready`. A broken URL is a stable answer too, and
//! without caching it the host would refetch and re-offer the same bytes every
//! frame — the image equivalent of the un-ticking checkbox `controls.rs` warns
//! about. A `<img>` whose decode failed keeps its CSS box and paints nothing,
//! which is what a browser's broken image looks like with no alt text styling.

use std::collections::HashMap;

use skia_safe::{Data, Image};

use crate::error::EngineError;
use crate::protocol;
use crate::tables::Tables;

const IMAGES: usize = protocol::Table::Images as usize;

enum State {
    Ready(Image),
    Failed,
}

#[derive(Default)]
pub struct Images {
    /// Per node, the images-table row, or -1. Dense because layout and paint ask
    /// per node; rebuilt on rescan because the table it mirrors is sparse.
    dense: Vec<i32>,
    /// Per table row, the node — so `provide` can find who grew when bytes land.
    nodes: Vec<i32>,
    /// Per table row, the `src` resolved out of the string arena. Owned because
    /// the arena is host memory, rewritten on the next commit.
    srcs: Vec<String>,
    /// Decoded bitmaps by `src` — see the module note.
    cache: HashMap<String, State>,
    /// Whether any row exists at all, so a page without images costs one branch.
    any: bool,
}

impl Images {
    pub fn new() -> Self {
        Self::default()
    }

    /// Rebuilds the dense index from the images table. Called when a commit
    /// changed the tables, beside the controls rescan.
    ///
    /// Only the index is rebuilt; the decode cache survives, which is the whole
    /// reason it is keyed by `src`. A relinked list row keeps its picture.
    pub fn rescan(&mut self, tables: &Tables, node_count: usize) {
        self.dense.clear();
        self.dense.resize(node_count, -1);
        self.nodes.clear();
        self.srcs.clear();
        self.any = false;

        let nodes = tables.i32s(IMAGES, protocol::images::NODE);
        let srcs = tables.i32s(IMAGES, protocol::images::SRC);
        for (row, &node) in nodes.iter().enumerate() {
            // Spare rows are `i32::MAX`, same convention as the controls table:
            // out of range is a skip, host memory being untrusted.
            if node < 0 || node as usize >= node_count {
                continue;
            }
            let src = tables
                .string(srcs.get(row).copied().unwrap_or(-1))
                .to_string();
            self.any = true;
            self.dense[node as usize] = row as i32;
            self.nodes.push(node);
            self.srcs.push(src);
        }
    }

    /// The bitmap for `node`, when its image has decoded. The paint path.
    #[inline]
    pub fn for_node(&self, node: usize) -> Option<&Image> {
        if !self.any {
            return None;
        }
        let row = *self.dense.get(node)?;
        if row < 0 {
            return None;
        }
        match self.cache.get(&self.srcs[row as usize]) {
            Some(State::Ready(image)) => Some(image),
            _ => None,
        }
    }

    /// The decoded pixel size for `node`'s image, when known. The layout path:
    /// a replaced element's intrinsic size, which is what an `<img>` with no
    /// CSS size measures to.
    #[inline]
    pub fn natural_size(&self, node: usize) -> Option<(f32, f32)> {
        let image = self.for_node(node)?;
        let (w, h) = (image.width() as f32, image.height() as f32);
        // A zero dimension is a decode artefact, not a size: dividing by it is
        // how the aspect math would turn a corrupt file into a NaN box.
        if w > 0.0 && h > 0.0 {
            Some((w, h))
        } else {
            None
        }
    }

    /// Whether `src` has been offered already, successfully or not. The host
    /// asks this to avoid refetching what it already offered — the table is
    /// republished on every commit, so "is there a row" cannot mean "fetch".
    pub fn resolved(&self, src: &str) -> bool {
        self.cache.contains_key(src)
    }

    /// Decodes `bytes` as `src`'s image and returns the nodes that grew.
    ///
    /// The caller — the FFI boundary, on behalf of the host — turns the node
    /// list into `mark_dirty` + a relayout, because a ready image changes what
    /// its node measures to. Decoding happens once per distinct `src`; a second
    /// offer of the same `src` is a no-op rather than a re-decode.
    ///
    /// A decode failure is remembered as `Failed`, not returned as an error:
    /// a 404 is content, not an engine malfunction, and the engine refusing to
    /// start over one broken `<img>` is the wrong blast radius.
    pub fn provide(&mut self, src: &str, bytes: &[u8]) -> Result<Vec<i32>, EngineError> {
        if self.resolved(src) {
            return Ok(Vec::new());
        }
        let decoded = Image::from_encoded(Data::new_copy(bytes));
        let state = match decoded {
            Some(image) if image.width() > 0 && image.height() > 0 => State::Ready(image),
            _ => State::Failed,
        };
        self.cache.insert(src.to_string(), state);

        Ok(self
            .nodes
            .iter()
            .zip(&self.srcs)
            .filter(|(_, s)| s.as_str() == src)
            .map(|(&n, _)| n)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 2x1 red-green PNG, generated once and pasted: the smallest real file
    /// that exercises the codec rather than a mock.
    const PNG_2X1: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x7b,
        0x40, 0xe8, 0xdd, 0x00, 0x00, 0x00, 0x0f, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0xc0, 0xc0, 0xf0, 0x9f, 0x01, 0x00, 0x07, 0xff, 0x01, 0xff, 0x01, 0x7f, 0x89, 0xa7,
        0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn a_decoded_image_reports_its_pixel_size() {
        let mut images = Images::new();
        images.nodes.push(3);
        images.srcs.push("a.png".to_string());
        images.dense.resize(4, -1);
        images.dense[3] = 0;
        images.any = true;

        let dirty = images.provide("a.png", PNG_2X1).expect("provide");
        assert_eq!(dirty, vec![3]);
        assert_eq!(images.natural_size(3), Some((2.0, 1.0)));
        assert!(images.for_node(3).is_some());
    }

    #[test]
    fn a_failed_decode_is_cached_not_fatal() {
        let mut images = Images::new();
        let dirty = images.provide("bad.png", b"not a png").expect("provide");
        assert!(dirty.is_empty());
        assert!(images.resolved("bad.png"));
        // A second offer is a no-op: the failure is the answer, cached.
        assert!(images
            .provide("bad.png", b"not a png")
            .expect("provide")
            .is_empty());
    }

    #[test]
    fn two_images_sharing_a_src_decode_once() {
        let mut images = Images::new();
        for node in [1, 2] {
            images.nodes.push(node);
            images.srcs.push("shared.png".to_string());
        }
        images.dense.resize(3, -1);
        images.dense[1] = 0;
        images.dense[2] = 1;
        images.any = true;

        let mut dirty = images.provide("shared.png", PNG_2X1).expect("provide");
        dirty.sort_unstable();
        assert_eq!(dirty, vec![1, 2]);
        assert_eq!(images.natural_size(1), Some((2.0, 1.0)));
        assert_eq!(images.natural_size(2), Some((2.0, 1.0)));
    }
}

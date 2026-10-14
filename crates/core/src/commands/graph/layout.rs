//! Lane layout of the graph.
//!
//! The rows come sorted by date, children always before parents (`--date-order`). The state is
//! the list of open lanes: each one waits for exactly one commit. It can be serialised and
//! travels along in the cursor, so the layout is seamless across page boundaries.
//!
//! Rules:
//! - A node takes the leftmost lane waiting for it; if none is waiting, the first free one.
//! - The first parent stays in the node's lane.
//! - Further parents branch off: into a lane already waiting for them, otherwise into the first free one.
//! - Lines passing through never change lanes; lanes that become free are reused.
//! - A stash hangs off the side of its base commit: the base's node does not take over the stash's lane.
//! - A lane keeps its colour from assignment to the end.

use serde::{Deserialize, Serialize};

use crate::model::GraphEdge;

/// An open lane: continues downwards until `target` appears.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lane {
    #[serde(rename = "t")]
    pub target: String,
    #[serde(rename = "c")]
    pub color: u32,
    /// Dashed: the line from the WIP row to the HEAD commit.
    #[serde(rename = "d", default, skip_serializing_if = "std::ops::Not::not")]
    pub dashed: bool,
    /// Attached at the side (stash): ends at the target but does not determine its lane.
    #[serde(rename = "s", default, skip_serializing_if = "std::ops::Not::not")]
    pub side: bool,
}

/// State between two rows (and between two pages).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayoutState {
    #[serde(rename = "l")]
    lanes: Vec<Option<Lane>>,
    #[serde(rename = "n")]
    next_color: u32,
}

/// Place of a row: lane and colour of the node, plus all line segments of the row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placed {
    pub lane: u32,
    pub color: u32,
    pub edges: Vec<GraphEdge>,
}

impl LayoutState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open lanes (index = lane).
    pub fn lanes(&self) -> &[Option<Lane>] {
        &self.lanes
    }

    /// Whether an open lane waits for `id` (a row further down will connect to it).
    pub fn awaits(&self, id: &str) -> bool {
        self.lanes.iter().any(|l| l.as_ref().is_some_and(|l| l.target == id))
    }

    /// Places the next row. `parents` in Git's order; `dashed` applies to
    /// the line to the first parent (only the WIP row).
    pub fn place(&mut self, id: &str, parents: &[String], dashed: bool) -> Placed {
        let waiting = self.lanes.iter().position(|l| l.as_ref().is_some_and(|l| l.target == id && !l.side));
        let (node, color) = match waiting {
            Some(i) => (i, self.lanes[i].as_ref().map_or(0, |l| l.color)),
            None => {
                let i = self.free_lane(0);
                (i, self.pick_color(i))
            }
        };
        self.finish(id, parents, node, color, dashed, false)
    }

    /// Places a row that hangs off the side of `parent` (stash): its own lane to the right of
    /// the one `parent` will appear in; the parent's node does not take over this lane.
    pub fn place_side(&mut self, id: &str, parent: &str) -> Placed {
        let awaited = self.lanes.iter().any(|l| l.as_ref().is_some_and(|l| l.target == parent && !l.side));
        // If no lane is waiting for the parent yet, it gets the first free one right away – that one stays empty here.
        let node = if awaited { self.free_lane(0) } else { self.free_lane(1) };
        let color = self.pick_color(node);
        self.finish(id, &[parent.to_string()], node, color, false, true)
    }

    fn finish(&mut self, id: &str, parents: &[String], node: usize, color: u32, dashed: bool, side: bool) -> Placed {
        let mut edges = Vec::with_capacity(self.lanes.len() + parents.len());
        for (i, slot) in self.lanes.iter_mut().enumerate() {
            let Some(lane) = slot else { continue };
            let ends_here = lane.target == id;
            edges.push(GraphEdge {
                top: Some(i as u32),
                bottom: if ends_here { None } else { Some(i as u32) },
                color: lane.color,
                dashed: lane.dashed,
            });
            if ends_here {
                *slot = None;
            }
        }

        let mut seen: Vec<&str> = Vec::with_capacity(parents.len());
        for parent in parents {
            // Do not draw broken commits (itself or the same parent twice) twice.
            if parent == id || seen.contains(&parent.as_str()) {
                continue;
            }
            if seen.is_empty() {
                self.lanes[node] = Some(Lane { target: parent.clone(), color, dashed, side });
                edges.push(GraphEdge { top: None, bottom: Some(node as u32), color, dashed });
            } else {
                let existing = self.lanes.iter().position(|l| l.as_ref().is_some_and(|l| &l.target == parent && !l.side));
                let (lane, lane_color) = match existing {
                    Some(j) => (j, self.lanes[j].as_ref().map_or(0, |l| l.color)),
                    None => {
                        let k = self.free_lane(0);
                        let c = self.pick_color(k);
                        self.lanes[k] = Some(Lane { target: parent.clone(), color: c, dashed: false, side: false });
                        (k, c)
                    }
                };
                edges.push(GraphEdge { top: None, bottom: Some(lane as u32), color: lane_color, dashed: false });
            }
            seen.push(parent);
        }

        while matches!(self.lanes.last(), Some(None)) {
            self.lanes.pop();
        }
        Placed { lane: node as u32, color, edges }
    }

    /// Free lane, skipping the first `skip` free ones; the slot exists in `lanes` afterwards.
    fn free_lane(&mut self, skip: usize) -> usize {
        let mut skipped = 0;
        let mut i = 0;
        loop {
            if i == self.lanes.len() {
                self.lanes.push(None);
            }
            if self.lanes[i].is_none() {
                if skipped == skip {
                    return i;
                }
                skipped += 1;
            }
            i += 1;
        }
    }

    /// Next colour; avoids one that would look the same as a neighbouring lane in the palette (8 colours).
    fn pick_color(&mut self, lane: usize) -> u32 {
        let neighbour = |i: Option<usize>| i.and_then(|i| self.lanes.get(i)).and_then(|l| l.as_ref()).map(|l| l.color % 8);
        let left = neighbour(lane.checked_sub(1));
        let right = neighbour(lane.checked_add(1));
        let mut color = self.next_color;
        for _ in 0..2 {
            if Some(color % 8) == left || Some(color % 8) == right {
                color = color.wrapping_add(1);
            }
        }
        self.next_color = color.wrapping_add(1);
        color
    }
}

/// Check of finished rows against the properties of the layout – for the tests here and those of the commands.
#[cfg(test)]
pub(crate) mod check {
    use std::collections::{HashMap, HashSet};

    use crate::model::{GraphRow, GraphRowKind};

    /// `complete`: `rows` reaches from the beginning to the end of the history (nothing comes
    /// in at the top, nothing goes out at the bottom).
    pub fn check_rows(rows: &[GraphRow], complete: bool) -> Result<(), String> {
        let index: HashMap<&str, usize> = rows.iter().enumerate().map(|(i, r)| (r.id.as_str(), i)).collect();
        if index.len() != rows.len() {
            return Err("a row occurs twice".into());
        }
        for (i, row) in rows.iter().enumerate() {
            let at = |what: &str| format!("row {i} ({}): {what}", row.id);

            // Each lane carries at most one line at the top; no line runs through the node.
            let mut tops = HashSet::new();
            for e in &row.edges {
                if let Some(t) = e.top {
                    if !tops.insert(t) {
                        return Err(at(&format!("zwei Linien kommen oben in Bahn {t} an")));
                    }
                }
                if e.top.is_none() && e.bottom.is_none() {
                    return Err(at("line segment without start and end"));
                }
                if e.top == Some(row.lane) && e.bottom == Some(row.lane) {
                    return Err(at("a line runs through the node"));
                }
                if let (Some(t), Some(b)) = (e.top, e.bottom) {
                    if t != b {
                        return Err(at(&format!("passing line changes lane {t} -> {b}")));
                    }
                }
            }

            // What leaves at the bottom in lane k arrives at the top of lane k in the next row – with the same colour.
            let bottoms: HashMap<u32, u32> = row.edges.iter().filter_map(|e| e.bottom.map(|b| (b, e.color))).collect();
            for e in &row.edges {
                if let Some(b) = e.bottom {
                    if bottoms.get(&b) != Some(&e.color) {
                        return Err(at(&format!("zwei Farben verlassen Bahn {b}")));
                    }
                }
            }
            match rows.get(i + 1) {
                Some(next) => {
                    let next_tops: HashMap<u32, u32> = next.edges.iter().filter_map(|e| e.top.map(|t| (t, e.color))).collect();
                    for (lane, color) in &bottoms {
                        match next_tops.get(lane) {
                            None => return Err(at(&format!("line leaves lane {lane} but does not arrive in the next row"))),
                            Some(c) if c != color => return Err(at(&format!("lane {lane} changes colour between two rows"))),
                            _ => {}
                        }
                    }
                    for lane in next_tops.keys() {
                        if !bottoms.contains_key(lane) {
                            return Err(at(&format!("in the next row a line appears out of nowhere in lane {lane}")));
                        }
                    }
                }
                None if complete && !bottoms.is_empty() => return Err(at("the last row has lines going down")),
                None => {}
            }
            if i == 0 && complete && !tops.is_empty() {
                return Err(at("the first row has lines coming from above"));
            }

            // The first parent stays in the node's lane.
            let starts: Vec<u32> = row.edges.iter().filter(|e| e.top.is_none()).filter_map(|e| e.bottom).collect();
            if !row.parents.is_empty() && !starts.contains(&row.lane) {
                return Err(at("the first parent leaves the node's lane"));
            }
            if row.kind == GraphRowKind::Merge && row.parents.len() < 2 {
                return Err(at("merge with fewer than two parents"));
            }

            // Every line starting at the node ends at the node of a parent – and every loaded parent is reached.
            let mut reached = HashSet::new();
            for &start in &starts {
                let mut lane = start;
                let mut found = None;
                for (j, below) in rows.iter().enumerate().skip(i + 1) {
                    let Some(edge) = below.edges.iter().find(|e| e.top == Some(lane)) else {
                        return Err(at(&format!("line in lane {lane} breaks off in row {j}")));
                    };
                    match edge.bottom {
                        None => {
                            found = Some(below.id.as_str());
                            break;
                        }
                        Some(b) => lane = b,
                    }
                }
                match found {
                    Some(id) if row.parents.iter().any(|p| p == id) => {
                        reached.insert(id.to_string());
                    }
                    Some(id) => return Err(at(&format!("line leads to {id}, which is not a parent"))),
                    None if complete => return Err(at(&format!("Linie in Bahn {start} erreicht nie einen Knoten"))),
                    None => {}
                }
            }
            for parent in &row.parents {
                if index.get(parent.as_str()).is_some_and(|&j| j > i) && !reached.contains(parent) {
                    return Err(at(&format!("not connected to the loaded parent {parent}")));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::check::check_rows;
    use super::*;
    use crate::model::{GraphRow, GraphRowKind};

    fn row(id: &str, parents: &[String], placed: Placed) -> GraphRow {
        GraphRow {
            id: id.to_string(),
            kind: if parents.len() > 1 { GraphRowKind::Merge } else { GraphRowKind::Commit },
            sha: Some(id.to_string()),
            lane: placed.lane,
            color: placed.color,
            edges: placed.edges,
            parents: parents.to_vec(),
            summary: String::new(),
            author_name: String::new(),
            author_email: String::new(),
            authored_at: None,
            refs: Vec::new(),
            is_head: false,
            stash_index: None,
            wip_count: None,
            collapsed_count: None,
            collapse_too_large: false,
            sync: crate::model::SyncMark::None,
        }
    }

    fn layout(history: &[(&str, &[&str])]) -> Vec<GraphRow> {
        let mut state = LayoutState::new();
        history
            .iter()
            .map(|(id, parents)| {
                let parents: Vec<String> = parents.iter().map(|p| p.to_string()).collect();
                let placed = state.place(id, &parents, false);
                row(id, &parents, placed)
            })
            .collect()
    }

    fn edge(top: Option<u32>, bottom: Option<u32>, color: u32) -> GraphEdge {
        GraphEdge { top, bottom, color, dashed: false }
    }

    #[test]
    fn linear_history_stays_in_lane_zero() {
        let rows = layout(&[("c", &["b"]), ("b", &["a"]), ("a", &[])]);
        check_rows(&rows, true).unwrap();
        assert!(rows.iter().all(|r| r.lane == 0 && r.color == 0));
        assert_eq!(rows[0].edges, vec![edge(None, Some(0), 0)]);
        assert_eq!(rows[1].edges, vec![edge(Some(0), None, 0), edge(None, Some(0), 0)]);
        assert_eq!(rows[2].edges, vec![edge(Some(0), None, 0)]);
    }

    #[test]
    fn merge_branches_off_and_joins_at_the_fork_point() {
        // m = merge of f2 into the main line; f1 and f2 branch off from b.
        let rows = layout(&[("m", &["b", "f2"]), ("f2", &["f1"]), ("f1", &["b"]), ("b", &["a"]), ("a", &[])]);
        check_rows(&rows, true).unwrap();
        let lanes: Vec<u32> = rows.iter().map(|r| r.lane).collect();
        assert_eq!(lanes, vec![0, 1, 1, 0, 0]);
        assert_eq!(rows[0].kind, GraphRowKind::Merge);
        assert_eq!(rows[0].edges, vec![edge(None, Some(0), 0), edge(None, Some(1), 1)]);
        // f2: the main line passes through in lane 0, its own line ends at the node and continues in lane 1.
        assert_eq!(rows[1].edges, vec![edge(Some(0), Some(0), 0), edge(Some(1), None, 1), edge(None, Some(1), 1)]);
        // b: both lanes end at the node, lane 1 is free afterwards.
        assert_eq!(rows[3].edges, vec![edge(Some(0), None, 0), edge(Some(1), None, 1), edge(None, Some(0), 0)]);
        assert_eq!(rows[4].edges, vec![edge(Some(0), None, 0)]);
    }

    #[test]
    fn freed_lanes_are_reused() {
        // Two branches one after the other: the second gets lane 1 again, with a new colour.
        let rows = layout(&[
            ("m2", &["m1", "y"]),
            ("y", &["m1"]),
            ("m1", &["a", "x"]),
            ("x", &["a"]),
            ("a", &[]),
        ]);
        check_rows(&rows, true).unwrap();
        assert_eq!(rows.iter().map(|r| r.lane).collect::<Vec<_>>(), vec![0, 1, 0, 1, 0]);
        assert_ne!(rows[1].color, rows[3].color);
        assert_eq!(rows.iter().flat_map(|r| r.edges.iter()).filter_map(|e| e.bottom).max(), Some(1));
    }

    #[test]
    fn second_parent_joins_a_lane_that_already_waits() {
        // t is a separate tip on a; m merges a (second parent) – there is no third lane for that.
        let rows = layout(&[("t", &["a"]), ("m", &["b", "a"]), ("b", &["a"]), ("a", &[])]);
        check_rows(&rows, true).unwrap();
        assert_eq!(rows[1].lane, 1);
        assert!(rows[1].edges.contains(&edge(None, Some(0), rows[0].color)));
        assert_eq!(rows.iter().flat_map(|r| r.edges.iter()).filter_map(|e| e.bottom).max(), Some(1));
    }

    #[test]
    fn octopus_merge_and_several_roots() {
        let rows = layout(&[("o", &["a", "b", "c"]), ("a", &[]), ("b", &[]), ("c", &[]), ("fremd", &[])]);
        check_rows(&rows, true).unwrap();
        assert_eq!(rows[0].edges.len(), 3);
        assert_eq!(rows[4].lane, 0);
        assert!(rows[4].edges.is_empty());
    }

    #[test]
    fn missing_parent_leaves_an_open_lane_without_panicking() {
        let rows = layout(&[("c", &["b"]), ("b", &["fehlt"])]);
        check_rows(&rows, false).unwrap();
        assert!(check_rows(&rows, true).is_err());
    }

    #[test]
    fn duplicate_and_self_parents_are_drawn_once() {
        let rows = layout(&[("c", &["b", "b", "c"]), ("b", &[])]);
        assert_eq!(rows[0].edges, vec![edge(None, Some(0), 0)]);
    }

    #[test]
    fn dashed_line_from_wip_to_head() {
        let mut state = LayoutState::new();
        let head = vec!["h".to_string()];
        let wip = state.place("wip", &head, true);
        assert_eq!(wip.edges, vec![GraphEdge { top: None, bottom: Some(0), color: 0, dashed: true }]);
        // Another tip lies above HEAD: the dashed line passes through.
        let other = state.place("x", &["h".to_string()], false);
        assert_eq!(other.lane, 1);
        assert!(other.edges.contains(&GraphEdge { top: Some(0), bottom: Some(0), color: 0, dashed: true }));
        let h = state.place("h", &["g".to_string()], false);
        assert_eq!(h.lane, 0);
        assert!(h.edges.contains(&GraphEdge { top: Some(0), bottom: None, color: 0, dashed: true }));
        // Below HEAD the line is solid again.
        assert!(h.edges.contains(&GraphEdge { top: None, bottom: Some(0), color: 0, dashed: false }));
        assert!(state.lanes().iter().flatten().all(|l| !l.dashed));
    }

    #[test]
    fn stash_hangs_beside_its_base() {
        // The base is a tip: it gets lane 0, the stash hangs to the right of it.
        let mut state = LayoutState::new();
        let stash = state.place_side("s", "b");
        assert_eq!(stash.lane, 1);
        assert_eq!(stash.edges, vec![edge(None, Some(1), stash.color)]);
        let second = state.place_side("s2", "b");
        assert_eq!(second.lane, 2);
        let base = state.place("b", &["a".to_string()], false);
        assert_eq!(base.lane, 0);
        assert_ne!(base.color, stash.color);
        assert_eq!(base.edges, vec![edge(Some(1), None, stash.color), edge(Some(2), None, second.color), edge(None, Some(0), base.color)]);
        assert_eq!(state.lanes().len(), 1);

        // A lane is already waiting for the base: the stash takes the first free one.
        let mut state = LayoutState::new();
        state.place("c", &["b".to_string()], false);
        let stash = state.place_side("s", "b");
        assert_eq!(stash.lane, 1);
        let base = state.place("b", &[], false);
        assert_eq!(base.lane, 0);
        assert!(state.lanes().is_empty());
        let json = serde_json::to_string(&{
            let mut s = LayoutState::new();
            s.place_side("s", "b");
            s
        })
        .unwrap();
        assert!(json.contains("\"s\":true"), "{json}");
    }

    #[test]
    fn neighbouring_lanes_get_different_palette_colors() {
        let mut state = LayoutState { lanes: Vec::new(), next_color: 7 };
        let a = state.place("a", &["x".to_string()], false);
        // The next colour would be 8 ≡ 0; next to it is 7 – no conflict. Then 9 ≡ 1 and so on.
        let b = state.place("b", &["y".to_string()], false);
        assert_ne!(a.color % 8, b.color % 8);
        let mut state = LayoutState { lanes: vec![Some(Lane { target: "x".into(), color: 3, dashed: false, side: false })], next_color: 11 };
        let c = state.place("c", &["y".to_string()], false);
        assert_eq!(c.lane, 1);
        assert_eq!(c.color, 12, "11 ≡ 3 would look like the neighbouring lane");
    }

    #[test]
    fn state_survives_serialization() {
        let mut state = LayoutState::new();
        state.place("wip", &["h".to_string()], true);
        state.place("m", &["a".to_string(), "b".to_string()], false);
        let json = serde_json::to_string(&state).unwrap();
        let back: LayoutState = serde_json::from_str(&json).unwrap();
        assert_eq!(back, state);
        assert!(json.contains("\"d\":true"));
    }

    /// Small fixed random generator (no extra package needed).
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self, bound: usize) -> usize {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((self.0 >> 33) as usize) % bound.max(1)
        }
    }

    /// Random DAG, already in topological order: parents always have a larger index.
    fn random_history(seed: u64, len: usize) -> Vec<(String, Vec<String>)> {
        let mut rng = Lcg(seed);
        (0..len)
            .map(|i| {
                let older = len - i - 1;
                let wanted = match rng.next(20) {
                    0 => 0,
                    1..=3 => 2,
                    4 => 3,
                    _ => 1,
                };
                let mut parents: Vec<String> = Vec::new();
                for _ in 0..wanted.min(older) {
                    // Mostly near parents, sometimes distant ones.
                    let span = if rng.next(6) == 0 { older } else { older.min(6) };
                    let p = format!("c{}", i + 1 + rng.next(span));
                    if !parents.contains(&p) {
                        parents.push(p);
                    }
                }
                (format!("c{i}"), parents)
            })
            .collect()
    }

    #[test]
    fn random_histories_keep_all_properties() {
        for seed in 0..300u64 {
            let history = random_history(seed, 30 + (seed as usize % 170));
            let mut state = LayoutState::new();
            let mut rows = Vec::new();
            for (id, parents) in &history {
                rows.push(row(id, parents, state.place(id, parents, false)));
            }
            check_rows(&rows, true).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
            assert!(state.lanes().is_empty(), "seed {seed}: lanes are still open at the end");
        }
    }

    #[test]
    fn paging_with_serialized_state_gives_the_same_rows() {
        for seed in 0..60u64 {
            let history = random_history(seed.wrapping_mul(7919) + 1, 240);
            let mut whole = LayoutState::new();
            let expected: Vec<GraphRow> = history.iter().map(|(id, p)| row(id, p, whole.place(id, p, false))).collect();

            let mut rng = Lcg(seed + 99);
            let mut rows = Vec::new();
            let mut state = LayoutState::new();
            let mut pos = 0;
            while pos < history.len() {
                let end = (pos + 1 + rng.next(40)).min(history.len());
                for (id, parents) in &history[pos..end] {
                    rows.push(row(id, parents, state.place(id, parents, false)));
                }
                // Page boundary: the state goes through the cursor.
                state = serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
                pos = end;
            }
            assert_eq!(rows, expected, "seed {seed}");
        }
    }

    #[test]
    fn checker_notices_broken_layouts() {
        let good = layout(&[("m", &["b", "f"]), ("f", &["b"]), ("b", &[])]);
        check_rows(&good, true).unwrap();

        let mut cut = good.clone();
        cut[1].edges.retain(|e| e.top != Some(0));
        assert!(check_rows(&cut, true).is_err(), "broken-off line");

        let mut doubled = good.clone();
        doubled[1].edges.push(edge(Some(0), Some(0), 5));
        assert!(check_rows(&doubled, true).is_err(), "two lines in one lane");

        let mut wrong_parent = good.clone();
        wrong_parent[0].parents = vec!["b".into(), "x".into()];
        assert!(check_rows(&wrong_parent, true).is_err(), "line to a non-parent");

        let mut recolored = good.clone();
        recolored[1].edges[0].color = 9;
        assert!(check_rows(&recolored, true).is_err(), "colour change within a lane");

        let mut unconnected = good;
        unconnected[0].edges.retain(|e| e.bottom != Some(1));
        unconnected[1].edges.retain(|e| e.top != Some(1));
        assert!(check_rows(&unconnected, true).is_err(), "parent not connected");
    }
}

//! Measuring: `count-objects`, free space, old reflog entries.

use super::test_support::*;
use super::{disk, measure};
use crate::model::ObjectStats;

#[test]
fn count_objects_fields_are_kib_and_become_bytes() {
    let text = "count: 10\nsize: 40\nin-pack: 1234\npacks: 2\nsize-pack: 3075\nprune-packable: 0\ngarbage: 1\nsize-garbage: 7\n";
    assert_eq!(
        measure::parse_count_objects(text),
        ObjectStats {
            loose_count: 10,
            loose_bytes: 40_960,
            in_pack: 1234,
            packs: 2,
            pack_bytes: 3_148_800,
            garbage_count: 1,
            garbage_bytes: 7_168,
            total_bytes: 3_196_928,
        }
    );
    assert_eq!(measure::parse_count_objects(""), ObjectStats::default());
}

#[tokio::test]
async fn object_counts_are_the_ones_git_reports() {
    let (tc, repo, id) = setup().await;
    for n in 0..5 {
        repo.commit_file(&format!("daten/messung-{n}.csv"), format!("station;wert\nNord;{n}\n"), "Messung");
    }
    repo.git(&["gc", "-q"]);
    for n in 0..3 {
        repo.commit_file(&format!("neu/Größe {n}.txt"), format!("{n}\n"), "Nach dem Packen");
    }
    let git = git_count_objects(&repo);
    assert!(git["count"] > 0 && git["packs"] >= 1, "fixture has loose objects and a pack: {git:?}");
    let stats = measure::count_objects(&tc, &id).await.unwrap();
    assert_eq!((stats.loose_count, stats.loose_bytes), (git["count"], git["size"] * 1024));
    assert_eq!((stats.packs, stats.in_pack, stats.pack_bytes), (git["packs"], git["in-pack"], git["size-pack"] * 1024));
    assert_eq!(stats.total_bytes, (git["size"] + git["size-pack"] + git["size-garbage"]) * 1024);
}

#[cfg(target_os = "linux")]
#[test]
fn free_space_is_the_one_df_reports() {
    let dir = crate::testkit::temp_folder();
    let out = std::process::Command::new("df").arg("-Pk").arg(dir.path()).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    let available_kib: u64 = text.lines().nth(1).unwrap().split_whitespace().nth(3).unwrap().parse().unwrap();
    let ours = disk::free_bytes(dir.path()).expect("free space known");
    let df = available_kib * 1024;
    // Other tests write meanwhile; a quarter GiB of slack.
    assert!(ours.abs_diff(df) < 256 * 1024 * 1024, "ours {ours}, df {df}");
}

#[test]
fn free_space_of_a_missing_folder_is_unknown() {
    let dir = crate::testkit::temp_folder();
    assert_eq!(disk::free_bytes(&dir.path().join("gibt es nicht")), None);
}

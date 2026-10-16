//! Repository clean-up: what takes space, and freeing it on request (`git gc` and friends).
//!
//! Nothing here runs on its own (spec Paket 10: no automatism, no AI). The preview only reads
//! (`GIT_OPTIONAL_LOCKS=0`). The run is a cancellable job under the network lock and then the
//! write lock of the repository and of every listed worktree that shares its Git directory, so no
//! fetch, commit or agent clean-up from Forkyard writes objects meanwhile. It never passes
//! `--force` to `git gc` and never deletes a lock file.

mod disk;
mod measure;

#[cfg(test)]
mod measure_tests;
#[cfg(test)]
mod test_support;

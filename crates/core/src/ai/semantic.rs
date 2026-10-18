//! Semantic commit search (spec 9.2): "Text | Meaning" in the commit search.
//!
//! The way (Entscheidung 7): (1) a local embedding provider from Settings › AI (Ollama or LM Studio
//! on this computer), else (2) the embeddings API of the main provider, else (3) rephrasing – the
//! model turns the question into search terms, code, paths, author and time window, the core
//! searches with the filters of the commit search and the model sorts the hits.
//!
//! The index lives in its own file `ai-index.db` in the data directory (not in the main database,
//! no migration), per repository and embedding model: subject, start of the message and changed
//! paths of every commit reachable from a branch, remote branch, tag or HEAD – newest first, at
//! most 200 000. It grows on every search and, once "Meaning" was used, in the background after a
//! fetch or commit; commits that are no longer reachable leave it.
//!
//! What goes to an embedder is repository content: the same exclusions, redaction and
//! confirmations (`ai::gate`) as every AI request, bound to exactly the sent text.

pub mod history;
pub mod index;
pub mod vector;

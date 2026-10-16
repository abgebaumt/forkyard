/**
 * Recommended length of a commit summary: many views cut the first line off after 72 characters.
 * The commit form, the reword editor and the squash editor count against it, and the core cuts
 * AI-written summaries at the same number (`ai::commit_message::SUMMARY_LIMIT`).
 */
export const SUMMARY_LIMIT = 72;

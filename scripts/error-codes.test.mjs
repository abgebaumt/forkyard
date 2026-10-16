// Tests of the error-code comparison (scripts/error-codes.mjs). Run: node --test scripts/error-codes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareErrorCodes, readErrorCodeSources } from "./error-codes.mjs";

const RUST = `
pub enum ErrorCode {
    /// Not a repository.
    NotARepo,
    Timeout,
}

impl ErrorCode {
    /// All codes, for tests and cross-checks.
    pub const ALL: [ErrorCode; 2] = [
        ErrorCode::NotARepo,
        ErrorCode::Timeout,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::NotARepo => "not_a_repo",
            ErrorCode::Timeout => "timeout",
        }
    }
}
`;
const TYPES = `export type ErrorCode =\n  | "not_a_repo"\n  /** Took too long; see the docs. */\n  | "timeout";\n\nexport interface Other { a: string; }\n`;
const ERRORS_TS = `const CODES: Record<ErrorCode, true> = {\n  not_a_repo: true,\n  timeout: true,\n};\n`;
const TEXTS = { not_a_repo: { text: "Not a repository.", hint: "Choose another folder." }, timeout: { text: "Too slow.", hint: "" } };
const GOOD = { rust: RUST, types: TYPES, errorsTs: ERRORS_TS, en: TEXTS, de: TEXTS };

test("agreeing sources report nothing", () => {
  assert.deepEqual(compareErrorCodes(GOOD), []);
});

test("a new variant that is only in the enum is reported everywhere it is missing", () => {
  const rust = RUST.replace("    Timeout,\n}", "    Timeout,\n    AiRefused,\n}").replace(
    'ErrorCode::Timeout => "timeout",',
    'ErrorCode::Timeout => "timeout",\n            ErrorCode::AiRefused => "ai_refused",',
  );
  const problems = compareErrorCodes({ ...GOOD, rust });
  assert.ok(problems.includes("ErrorCode::AiRefused is missing from ErrorCode::ALL"), problems.join("\n"));
  assert.ok(problems.includes('src/core/types.ts ErrorCode: "ai_refused" is missing'), problems.join("\n"));
  assert.ok(problems.includes('src/app/errors.ts CODES: "ai_refused" is missing'), problems.join("\n"));
  assert.ok(problems.includes('en/errors.json: "ai_refused" is missing'), problems.join("\n"));
  assert.ok(problems.includes('de/errors.json: "ai_refused" is missing'), problems.join("\n"));
});

test("a wrong length of ALL and a variant without as_str are reported", () => {
  const rust = RUST.replace("[ErrorCode; 2]", "[ErrorCode; 3]").replace('            ErrorCode::Timeout => "timeout",\n', "");
  const problems = compareErrorCodes({ ...GOOD, rust });
  assert.ok(problems.includes("ErrorCode::ALL declares 3 entries but lists 2"), problems.join("\n"));
  assert.ok(problems.includes("ErrorCode::Timeout has no text in as_str"), problems.join("\n"));
});

test("an extra TS code and an incomplete German text are reported", () => {
  const types = TYPES.replace('| "timeout";', '| "timeout"\n  | "gibt_es_nicht";');
  const de = { not_a_repo: { text: "Kein Repository." }, timeout: { text: "Zu langsam.", hint: "" } };
  const problems = compareErrorCodes({ ...GOOD, types, de });
  assert.ok(problems.includes('src/core/types.ts ErrorCode: "gibt_es_nicht" is not an ErrorCode in error.rs'), problems.join("\n"));
  assert.ok(problems.includes('de/errors.json: "not_a_repo" needs "text" and "hint"'), problems.join("\n"));
});

test("the repository's own sources agree", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(compareErrorCodes(readErrorCodeSources(root)), []);
});

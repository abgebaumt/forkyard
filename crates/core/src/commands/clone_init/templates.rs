//! Built-in templates for `repo_init`: .gitignore lists (written by us, short) and license
//! texts in their original wording.

/// A built-in template.
pub struct Template {
    pub key: &'static str,
    pub label: &'static str,
    pub text: &'static str,
}

/// Placeholder in license texts.
pub const YEAR: &str = "{{year}}";
pub const HOLDER: &str = "{{holder}}";

pub const GITIGNORE: &[Template] = &[
    Template { key: "node", label: "Node.js", text: include_str!("gitignore/node.txt") },
    Template { key: "python", label: "Python", text: include_str!("gitignore/python.txt") },
    Template { key: "rust", label: "Rust", text: include_str!("gitignore/rust.txt") },
    Template { key: "java", label: "Java", text: include_str!("gitignore/java.txt") },
    Template { key: "go", label: "Go", text: include_str!("gitignore/go.txt") },
    Template { key: "cpp", label: "C / C++", text: include_str!("gitignore/cpp.txt") },
    Template { key: "dotnet", label: ".NET", text: include_str!("gitignore/dotnet.txt") },
    Template { key: "unity", label: "Unity", text: include_str!("gitignore/unity.txt") },
    Template { key: "macos", label: "macOS system files", text: include_str!("gitignore/macos.txt") },
    Template { key: "windows", label: "Windows system files", text: include_str!("gitignore/windows.txt") },
    Template { key: "linux", label: "Linux system files", text: include_str!("gitignore/linux.txt") },
    Template { key: "jetbrains", label: "JetBrains IDEs", text: include_str!("gitignore/jetbrains.txt") },
    Template { key: "vscode", label: "VS Code", text: include_str!("gitignore/vscode.txt") },
];

/// Keys are the SPDX identifiers.
pub const LICENSES: &[Template] = &[
    Template { key: "MIT", label: "MIT License", text: include_str!("license/mit.txt") },
    Template { key: "Apache-2.0", label: "Apache License 2.0", text: include_str!("license/apache-2.0.txt") },
    Template { key: "BSD-2-Clause", label: "BSD 2-Clause License", text: include_str!("license/bsd-2-clause.txt") },
    Template { key: "BSD-3-Clause", label: "BSD 3-Clause License", text: include_str!("license/bsd-3-clause.txt") },
    Template { key: "ISC", label: "ISC License", text: include_str!("license/isc.txt") },
    Template { key: "Unlicense", label: "The Unlicense (public domain)", text: include_str!("license/unlicense.txt") },
];

pub fn find<'a>(list: &'a [Template], key: &str) -> Option<&'a Template> {
    list.iter().find(|t| t.key.eq_ignore_ascii_case(key.trim()))
}

/// Template text with uniform line endings (`\n`), independent of the checkout.
pub fn text(template: &Template) -> String {
    template.text.replace("\r\n", "\n")
}

/// License text with the year and name of the copyright holder.
pub fn license_text(template: &Template, year: &str, holder: &str) -> String {
    text(template).replace(YEAR, year).replace(HOLDER, holder)
}

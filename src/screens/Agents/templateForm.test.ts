import { describe, expect, it } from "vitest";
import { formFromTemplate, newTemplateForm, templateFromForm } from "./templateForm";

describe("agents: own template form", () => {
  it("turns lines into arguments and empty optional lists into null", () => {
    const form = { ...newTemplateForm("custom:1"), name: "  Aider ", program: " aider ", args: "--message-file\n${taskFile}\n\n  --yes  \r\n", unattendedArgs: "  \n", resumeArgs: "--restore-chat-history", statusHook: true };
    expect(templateFromForm(form)).toEqual({
      id: "custom:1",
      name: "Aider",
      program: "aider",
      args: ["--message-file", "${taskFile}", "--yes"],
      unattendedArgs: null,
      resumeArgs: ["--restore-chat-history"],
      statusHook: true,
    });
  });
  it("round-trips a stored template", () => {
    const stored = { id: "custom:2", name: "Mein Agent", program: "C:\\Tools\\agent.exe", args: ["--cwd", "${worktree}"], unattendedArgs: ["--auto"], resumeArgs: null, statusHook: false };
    expect(templateFromForm(formFromTemplate(stored))).toEqual(stored);
    expect(formFromTemplate(stored).unattendedArgs).toBe("--auto");
    expect(newTemplateForm("custom:3")).toEqual({ id: "custom:3", name: "My agent", program: "", args: "", unattendedArgs: "", resumeArgs: "", statusHook: false });
  });
});

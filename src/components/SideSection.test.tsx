import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SideSection } from "./SideSection";

function render(extra: { notice?: React.ReactNode; footer?: React.ReactNode }) {
  return renderToStaticMarkup(
    <SideSection
      id="test"
      title="Test"
      open
      onToggle={() => {}}
      listLabel="Rows"
      items={["a", "b"]}
      itemId={(item) => item}
      itemText={(item) => item}
      renderRow={(item, state) => (
        <div key={item} {...state.attrs}>
          {item}
        </div>
      )}
      rowMenu={() => []}
      sectionMenu={[]}
      {...extra}
    />,
  );
}

describe("SideSection", () => {
  it("puts the notice above and the footer below the rows", () => {
    const html = render({ notice: <p data-test="notice" />, footer: <p data-test="footer" /> });
    const tree = html.indexOf('role="tree"');
    const lastRow = html.indexOf('data-side-row="b"');
    expect(tree).toBeGreaterThan(-1);
    expect(html.indexOf('data-test="notice"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-test="notice"')).toBeLessThan(tree);
    expect(html.indexOf('data-test="footer"')).toBeGreaterThan(lastRow);
  });
});

// Builds the website from README.md into _site/: the README, rendered, with
// the Taut and Slick plugins the Website workflow downloads into
// _site/plugins/ before running this. Run with `bun site/build.ts`.
import { $ } from "bun";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "_site");
const repo = "https://github.com/ingoau/huddlefm";

const readme = await readFile(join(root, "README.md"), "utf8");
const template = await readFile(join(import.meta.dir, "template.html"), "utf8");

// The README opens with a warning line, the title and a one paragraph intro,
// which the page shows as its header; the rest is the page's body.
const title = readme.indexOf("# HuddleFM\n");
const features = readme.indexOf("\n## Features\n");
if (title < 0 || features < 0)
  throw new Error("README.md has moved its title or Features");
const warning = readme.slice(0, title).trim();
const intro = readme.slice(title + "# HuddleFM\n".length, features).trim();
const body = readme.slice(features);

const html = (markdown: string) =>
  Bun.markdown
    .html(markdown, { headings: { ids: true } })
    // Links into the repo go to GitHub.
    .replace(
      /href="(?!https?:|mailto:|#)([^"]*)"/g,
      (_, path) => `href="${repo}/blob/main/${path}"`,
    )
    // Wide tables scroll on their own instead of the page.
    .replace(/<table>/g, '<div class="table"><table>')
    .replace(/<\/table>/g, "</table></div>");

const plugins = [
  {
    name: "Taut",
    about: `${repo}/tree/main/clients/taut#readme`,
    files: [
      {
        path: "plugins/taut/HuddleFM.js",
        note: "Install from Slack's Preferences → Taut",
      },
    ],
  },
  {
    name: "Slick",
    about: `${repo}/tree/main/clients/slick#readme`,
    files: [
      {
        path: "plugins/slick/HuddleFM.js",
        note: "For the desktop app and the browser extension",
      },
      {
        path: "plugins/slick/HuddleFM.user.js",
        note: "Userscript, for Violentmonkey beside Slick",
      },
    ],
  },
];
const missing = plugins
  .flatMap((p) => p.files)
  .filter((f) => !existsSync(join(out, f.path)));
if (missing.length)
  console.warn(
    `Not built, linked anyway: ${missing.map((f) => f.path).join(", ")}`,
  );

const sha =
  process.env.GITHUB_SHA ??
  (await $`git rev-parse HEAD`.cwd(root).text()).trim();
const pluginSection = `<section id="plugins">
  <h2>Client plugins</h2>
  <p>Put HuddleFM's controls, queue and settings in the huddle's own toolbar. Built from <a href="${repo}/commit/${sha}"><code>${sha.slice(0, 7)}</code></a>.</p>
  ${plugins
    .map(
      (p) => `<div class="plugin">
    <h3>${p.name} <a href="${p.about}">About</a></h3>
    ${p.files
      .map(
        (f) => `<div class="file">
      <div><a href="${f.path}" download><code>${f.path.split("/").pop()}</code></a><span>${f.note}</span></div>
      <button type="button" data-copy="${f.path}">Copy link</button>
    </div>`,
      )
      .join("\n    ")}
  </div>`,
    )
    .join("\n  ")}
</section>`;

// The plugins go before Self hosting, after what HuddleFM does.
const content = html(body).replace(
  '<h2 id="self-hosting">',
  (h) => `${pluginSection}\n${h}`,
);
if (!content.includes('id="plugins"'))
  throw new Error("README.md has no Self hosting section");

const page = template
  .replace("{{warning}}", () => html(warning))
  .replace("{{intro}}", () => html(intro))
  .replace("{{content}}", () => content);

await mkdir(out, { recursive: true });
await writeFile(join(out, "index.html"), page);
await copyFile(join(root, "clients/core/logo.png"), join(out, "logo.png"));
// Lexend, served from the site rather than a font CDN.
await mkdir(join(out, "fonts"), { recursive: true });
for (const subset of ["latin", "latin-ext"]) {
  const file = `lexend-${subset}-wght-normal.woff2`;
  await copyFile(
    join(root, "node_modules/@fontsource-variable/lexend/files", file),
    join(out, "fonts", file),
  );
}
console.log(`Built ${join(out, "index.html")}`);

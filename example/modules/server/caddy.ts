import { module } from "rig";

export const caddy = module("caddy", (ctx, opts: { sites: string[] }) => {
  ctx.pkg.repo("caddy", {
    uris: "https://dl.cloudsmith.io/public/caddy/stable/deb/debian",
    suites: "any-version",
    key: "keys/caddy.asc",
  });
  ctx.pkg(["caddy"]);

  const caddyfile = ctx.file(
    "/etc/caddy/Caddyfile",
    opts.sites.map((s) => `${s} {\n  reverse_proxy localhost:3000\n}\n`).join("\n"),
  );
  // secrets/caddy.env.age — create it with `rig secret edit caddy.env`. Written as 0600, redacted in plans.
  const env = ctx.file("/etc/caddy/env", ctx.tmpl`
    CF_API_TOKEN=${ctx.secret("caddy.env")}
  `);
  ctx.unit("caddy", { started: true, restartOn: [caddyfile, env] });
});

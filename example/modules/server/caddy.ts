import { module } from "rig";

export const caddy = module("caddy", ({ pkg, file, unit, secret, tmpl }, opts: { sites: string[] }) => {
  pkg.repo("caddy", {
    uris: "https://dl.cloudsmith.io/public/caddy/stable/deb/debian",
    suites: "any-version",
    key: "keys/caddy.asc",
  });
  pkg(["caddy"]);

  const caddyfile = file(
    "/etc/caddy/Caddyfile",
    opts.sites.map((s) => `${s} {\n  reverse_proxy localhost:3000\n}\n`).join("\n"),
  );
  // secrets/caddy.env.age — create it with `rig secret edit caddy.env`. Written as 0600, redacted in plans.
  const env = file("/etc/caddy/env", tmpl`
    CF_API_TOKEN=${secret("caddy.env")}
  `);
  unit("caddy", { started: true, restartOn: [caddyfile, env] });
});

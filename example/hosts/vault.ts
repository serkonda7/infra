import { host } from "rig";
import { base } from "../modules/base";
import { hardening } from "../modules/server/hardening";
import { caddy } from "../modules/server/caddy";

export default host({
  os: "debian",
  // Applied over SSH; sshd/firewall changes are reverted unless a fresh login works within 120s.
  connect: { ssh: "john@vault.lan", sudo: "password" },
  modules: [base, hardening, caddy({ sites: ["git.example.com"] })],
});

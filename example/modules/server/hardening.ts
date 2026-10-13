import { module } from "rig";

export const hardening = module("hardening", (ctx) => {
  ctx.pkg(["nftables", "unattended-upgrades"]);

  const sshd = ctx.file(
    "/etc/ssh/sshd_config.d/10-rig.conf",
    ctx.tmpl`
      PasswordAuthentication no
      PermitRootLogin no
    `,
  );
  ctx.unit("ssh", { restartOn: [sshd] });

  const rules = ctx.file(
    "/etc/nftables.conf",
    ctx.tmpl`
      #!/usr/sbin/nft -f
      flush ruleset
      table inet filter {
        chain input {
          type filter hook input priority 0; policy drop;
          ct state established,related accept
          iif lo accept
          tcp dport { 22, 80, 443 } accept
        }
      }
    `,
  );
  ctx.unit("nftables", { started: true, restartOn: [rules] });
});

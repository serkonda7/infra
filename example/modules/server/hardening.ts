import { module } from "rig";

export const hardening = module("hardening", ({ pkg, file, unit, tmpl }) => {
  pkg(["nftables", "unattended-upgrades"]);

  const sshd = file(
    "/etc/ssh/sshd_config.d/10-rig.conf",
    tmpl`
      PasswordAuthentication no
      PermitRootLogin no
    `,
  );
  unit("ssh", { restartOn: [sshd] });

  const rules = file(
    "/etc/nftables.conf",
    tmpl`
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
  unit("nftables", { started: true, restartOn: [rules] });
});

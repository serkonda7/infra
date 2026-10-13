# Remote hosts and secrets

A host with `connect: { ssh: "john@vault.lan" }` is applied over SSH. rig
uploads itself and a bundle of the config, evaluates on the target, and
streams the plan back, so `rig plan vault` looks just like a local run.
Changes that could cut the connection (sshd, firewall, network) are applied
last, behind a dead-man's switch.

Secrets are age files encrypted to `secrets/recipients` (your SSH/age keys and
each host's key): `rig secret edit <name>`, `rig secret rekey`, `rig secret ls`.

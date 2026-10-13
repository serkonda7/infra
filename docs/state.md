# State, pruning and rollback

Live state is always re-read. A *generation*
(`~/.local/state/rig/hosts/<host>/generations/<n>.json`) records what rig owns
after each apply, along with the git commit and the snapper snapshot. The next
apply removes whatever an earlier generation owned that is no longer declared,
but only if it is still what rig left there. Files you edited block removal
until you pass `--force`.

```sh
rig gen ls                 # generations, with commit, snapshot, "rollback of n"
rig rollback 41            # re-apply generation 41's commit (temporary git worktree) as a new generation
rig gen gc --keep 10       # drop old generations and backups nothing refers to
```

Rollback evaluates the old commit, but links keep pointing into your working
copy. Content behind links is a git matter (`git checkout <commit> -- dotfiles/…`).
For system-level rollback, boot a snapper snapshot from the Limine menu.

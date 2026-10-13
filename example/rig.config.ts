import { defineConfig } from "rig";

export default defineConfig({
  hosts: {
    zephyr: () => import("./hosts/zephyr"),
    vault: () => import("./hosts/vault"),
  },
  defaults: { user: "john", email: "john@example.com" },
});

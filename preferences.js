window.StorScanPreferences = {
  pref(name) { return `extensions.storscan.${name}`; },
  get(name, fallback) {
    try { const v = Zotero.Prefs.get(this.pref(name), true); return v === undefined || v === null || v === "" ? fallback : v; } catch (e) { return fallback; }
  },
  set(name, value) { Zotero.Prefs.set(this.pref(name), value, true); },
  async init() {
    try {
      let base = Zotero.Prefs.get("baseAttachmentPath") || "Not configured";
      if (base && typeof base !== "string" && base.path) base = base.path;
      document.getElementById("storscan-pref-base-path").textContent = base || "Not configured";
      const status = document.getElementById("storscan-pref-status");
      if (!base || base === "Not configured") status.textContent = "✕ Base directory not configured";
      else {
        let exists = false, writable = false;
        try { exists = await IOUtils.exists(base); if (exists) { const probe = PathUtils.join(base, ".storscan-write-test"); await IOUtils.writeUTF8(probe, "test"); await IOUtils.remove(probe); writable = true; } } catch (e) {}
        status.textContent = `${exists ? "✓" : "✕"} Base directory found\n${writable ? "✓" : "✕"} Writable`;
      }
      document.getElementById("storscan-folder-template").value = this.get("folderTemplate", "{{firstCreator}}{{multipleAuthors}}");
      document.getElementById("storscan-multiple-suffix").value = this.get("multipleAuthorsSuffix", " et al");
      document.getElementById("storscan-max-filename").value = this.get("maxFilenameLength", 80);
      document.getElementById("storscan-save-author-settings").addEventListener("click", () => this.saveAuthorSettings());
      document.getElementById("storscan-unpaywall-email").value = this.get("unpaywallEmail", "");
      document.getElementById("storscan-enable-unpaywall").checked = this.get("enableUnpaywall", true) !== false;
      document.getElementById("storscan-save-fulltext-settings").addEventListener("click", () => this.saveFullTextSettings());
    } catch (e) { Zotero.logError(e); }
  },
  saveFullTextSettings() {
    const email = document.getElementById("storscan-unpaywall-email").value.trim();
    const enabled = document.getElementById("storscan-enable-unpaywall").checked;
    this.set("unpaywallEmail", email);
    this.set("enableUnpaywall", enabled);
    const saved = document.getElementById("storscan-fulltext-saved");
    saved.textContent = "Settings saved.";
    setTimeout(() => { saved.textContent = ""; }, 2500);
  },
  saveAuthorSettings() {
    const folderTemplate = document.getElementById("storscan-folder-template").value.trim() || "{{firstCreator}}{{multipleAuthors}}";
    const suffix = document.getElementById("storscan-multiple-suffix").value;
    let maxLength = parseInt(document.getElementById("storscan-max-filename").value, 10);
    if (!Number.isFinite(maxLength)) maxLength = 80;
    maxLength = Math.max(30, Math.min(200, maxLength));
    this.set("folderTemplate", folderTemplate);
    this.set("multipleAuthorsSuffix", suffix);
    this.set("maxFilenameLength", maxLength);
    document.getElementById("storscan-max-filename").value = maxLength;
    const saved = document.getElementById("storscan-settings-saved");
    saved.textContent = "Settings saved.";
    setTimeout(() => { saved.textContent = ""; }, 2500);
  }
};

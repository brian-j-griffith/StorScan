/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci */
var StorageScannerPlugin = {
  id: null, version: null, rootURI: null, windows: new Set(), running: false, activeProgressWindows: new Set(),
  menuIDs: ["ss-sep", "ss-menu", "ss-context-menu", "ss-icon-style"],

  init(meta) { Object.assign(this, meta); },
  prefKey(name) { return `extensions.storscan.${name}`; },
  getPref(name, fallback) {
    try {
      const value = Zotero.Prefs.get(this.prefKey(name), true);
      return value === undefined || value === null || value === "" ? fallback : value;
    } catch (e) { return fallback; }
  },
  setPref(name, value) { Zotero.Prefs.set(this.prefKey(name), value, true); },
  async registerPreferences() {
    try {
      await Zotero.PreferencePanes.register({
        pluginID: this.id,
        id: "storscan-preferences",
        label: "StorScan",
        image: this.rootURI + "icon-24.png",
        src: this.rootURI + "preferences.xhtml",
        scripts: [this.rootURI + "preferences.js"],
        stylesheets: [this.rootURI + "preferences.css"]
      });
    } catch (e) {
      Zotero.logError(e);
    }
  },
  addToAllWindows() { for (const win of Zotero.getMainWindows()) this.addToWindow(win); },
  removeFromAllWindows() { for (const win of [...this.windows]) this.removeFromWindow(win); },
  menu(win, popup, id, label, fn) {
    const item = win.document.createXULElement("menuitem");
    item.id = id; item.setAttribute("label", label);
    item.addEventListener("command", () => Promise.resolve(fn.call(this, win)).catch(e => this.fail(win, e)));
    popup.appendChild(item);
  },
  menuHeader(win, popup, label) {
    const item = win.document.createXULElement("menuitem");
    item.setAttribute("label", label.toUpperCase());
    item.setAttribute("class", "storscan-menu-heading");
    item.setAttribute("disabled", "true");
    item.setAttribute("aria-disabled", "true");
    item.setAttribute("tabindex", "-1");
    item.setAttribute("style", "color: #6f6f73 !important; opacity: 1 !important; font-size: 0.82em; font-weight: 600; letter-spacing: 0.02em;");
    popup.appendChild(item);
  },
  addToWindow(win) {
    if (!win || win.closed || win.document.getElementById("ss-menu")) return;
    const toolsPopup = win.document.getElementById("menu_ToolsPopup"); if (!toolsPopup) return;

    // Use Zotero's native menu icon slot for layout, but draw the untinted artwork
    // as a CSS background so macOS cannot recolor it on hover/selection.
    if (!win.document.getElementById("ss-icon-style")) {
      const style = win.document.createElementNS("http://www.w3.org/1999/xhtml", "style");
      style.id = "ss-icon-style";
      style.textContent = `
        #ss-menu, #ss-context-menu {
          list-style-image: none !important;
          -moz-context-properties: none !important;
        }
        #ss-menu > .menu-iconic-left,
        #ss-context-menu > .menu-iconic-left {
          display: -moz-box !important;
          width: 18px !important;
          min-width: 18px !important;
          height: 18px !important;
          min-height: 18px !important;
          margin-inline: 8px 7px !important;
          background: transparent url("${this.rootURI}storscan-menu-36.png") center / 18px 18px no-repeat !important;
          -moz-context-properties: none !important;
          filter: none !important;
          opacity: 1 !important;
        }
        #ss-menu > .menu-iconic-left > .menu-iconic-icon,
        #ss-context-menu > .menu-iconic-left > .menu-iconic-icon {
          display: none !important;
          list-style-image: none !important;
        }
        #ss-menu[_moz-menuactive="true"] > .menu-iconic-left,
        #ss-context-menu[_moz-menuactive="true"] > .menu-iconic-left,
        #ss-menu:hover > .menu-iconic-left,
        #ss-context-menu:hover > .menu-iconic-left {
          background-image: url("${this.rootURI}storscan-menu-36.png") !important;
          filter: none !important;
          opacity: 1 !important;
        }
      `;
      win.document.documentElement.appendChild(style);
    }

    const sep = win.document.createXULElement("menuseparator"); sep.id = "ss-sep"; toolsPopup.appendChild(sep);

    const rootMenu = win.document.createXULElement("menu");
    rootMenu.id = "ss-menu";
    rootMenu.setAttribute("label", "StorScan");
    rootMenu.setAttribute("class", "menu-iconic");
    rootMenu.setAttribute("image", this.rootURI + "storscan-menu-36.png");
    const popup = win.document.createXULElement("menupopup");
    rootMenu.appendChild(popup);
    toolsPopup.appendChild(rootMenu);

    this.menuHeader(win, popup, "Scan & Fix");
    this.menu(win, popup, "ss-scan", "Scan Library", this.scan);
    this.menu(win, popup, "ss-outside-base", "Fix Misplaced Files", this.normalizeOutsideBase);
    this.menu(win, popup, "ss-preview", "Preview Cleanup", this.previewCleanup);
    popup.appendChild(win.document.createXULElement("menuseparator"));

    this.menuHeader(win, popup, "Organize & Repair");
    this.menu(win, popup, "ss-normalize-selected", "Organize Selected Item", this.normalizeSelectedItem);
    this.menu(win, popup, "ss-normalize-linked", "Organize All Files", this.normalizeLinkedFiles);
    this.menu(win, popup, "ss-convert-stored", "Convert Stored Files", this.convertStoredFiles);
    this.menu(win, popup, "ss-remove-broken", "Remove Broken Links", this.removeBrokenRecords);
    this.menu(win, popup, "ss-dedupe", "Merge Duplicate Files", this.consolidateDuplicates);
    this.menu(win, popup, "ss-item-dedupe", "Merge Item Attachments", this.consolidateItemDuplicates);
    popup.appendChild(win.document.createXULElement("menuseparator"));

    this.menuHeader(win, popup, "Rename");
    this.menu(win, popup, "ss-preview-rename", "Preview Renaming", this.previewRenameLinkedAttachments);
    this.menu(win, popup, "ss-rename-linked", "Rename All Attachments", this.renameLinkedAttachments);
    popup.appendChild(win.document.createXULElement("menuseparator"));

    this.menuHeader(win, popup, "Find Full Text");
    this.menu(win, popup, "ss-find-legal", "Find Open Full Text", this.findLegalFullText);
    this.menu(win, popup, "ss-attach-local", "Attach Local File", this.attachLocalCopy);
    this.menu(win, popup, "ss-open-library", "Open Library Search", this.openLibrarySearch);
    this.menu(win, popup, "ss-fulltext-settings", "Full-Text Settings", this.showFullTextSettings);
    popup.appendChild(win.document.createXULElement("menuseparator"));

    this.menuHeader(win, popup, "Utilities");
    this.menu(win, popup, "ss-inspect-selected", "Inspect Selected Item", this.inspectSelectedItem);
    this.menu(win, popup, "ss-base", "Open Base Directory", this.showBaseDirectory);

    const itemMenu = win.document.getElementById("zotero-itemmenu");
    if (itemMenu && !win.document.getElementById("ss-context-menu")) {
      const contextMenu = win.document.createXULElement("menu");
      contextMenu.id = "ss-context-menu";
      contextMenu.setAttribute("label", "StorScan");
      contextMenu.setAttribute("class", "menu-iconic");
      contextMenu.setAttribute("image", this.rootURI + "storscan-menu-36.png");
      const contextPopup = win.document.createXULElement("menupopup");
      this.menu(win, contextPopup, "ss-context-find-legal", "Find Open Full Text", this.findLegalFullText);
      this.menu(win, contextPopup, "ss-context-attach-local", "Attach Local File", this.attachLocalCopy);
      this.menu(win, contextPopup, "ss-context-open-library", "Open Library Search", this.openLibrarySearch);
      contextPopup.appendChild(win.document.createXULElement("menuseparator"));
      this.menu(win, contextPopup, "ss-context-normalize", "Organize Selected Item", this.normalizeSelectedItem);
      this.menu(win, contextPopup, "ss-context-inspect", "Inspect Selected Item", this.inspectSelectedItem);
      contextMenu.appendChild(contextPopup);
      itemMenu.appendChild(contextMenu);
    }
    this.windows.add(win);
  },
  removeFromWindow(win) { if (!win || win.closed) return; for (const id of this.menuIDs) win.document.getElementById(id)?.remove(); this.windows.delete(win); },
  closeActiveProgressWindows() {
    for (const progress of [...this.activeProgressWindows]) {
      try { progress.close(); } catch (e) {}
      try {
        const popup = progress?._window || progress?.window || progress?._progressWindow || null;
        if (popup && !popup.closed) popup.close();
      } catch (e) {}
      this.activeProgressWindows.delete(progress);
    }
  },
  fail(win, e) {
    this.closeActiveProgressWindows();
    Zotero.logError(e);
    Services.prompt.alert(win, "StorScan", `Operation failed:\n\n${e.message || e}`);
  },
  confirm(win, title, text) { return Services.prompt.confirm(win, title, text); },
  alert(win, title, text) { Services.prompt.alert(win, title, text); },
  escapeHTML(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },
  reportFilename(title) {
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
    const clean = String(title || "Report").replace(/^StorScan\s*[—-]?\s*/i, "").replace(/[\/:*?"<>|]+/g, "-").trim();
    return `StorScan - ${clean || "Report"} - ${stamp}.txt`;
  },
  async saveTextReport(win, title, text) {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    picker.init(win, "Save StorScan Report", Ci.nsIFilePicker.modeSave);
    picker.defaultString = this.reportFilename(title);
    picker.defaultExtension = "txt";
    picker.appendFilter("Text files", "*.txt");
    picker.appendFilters(Ci.nsIFilePicker.filterAll);
    const result = await new Promise(resolve => picker.open(resolve));
    if (result !== Ci.nsIFilePicker.returnOK && result !== Ci.nsIFilePicker.returnReplace) return;
    await IOUtils.writeUTF8(picker.file.path, text);
  },
  showReport(win, title, summary, details = "") {
    const fullText = [
      title,
      `Generated: ${new Date().toLocaleString()}`,
      "",
      String(summary || ""),
      details ? `\nDETAILS\n-------\n${details}` : ""
    ].filter(Boolean).join("\n");
    const reportWin = win.openDialog("about:blank", "_blank", "chrome,resizable,centerscreen,dialog=no", null);
    const render = () => {
      try {
        const doc = reportWin.document;
        doc.title = title;
        const screen = reportWin.screen || {};
        const maxW = Math.max(640, Math.min(1120, Math.floor((screen.availWidth || 1280) * 0.88)));
        const maxH = Math.max(420, Math.min(820, Math.floor((screen.availHeight || 900) * 0.78)));
        reportWin.resizeTo(Math.min(900, maxW), Math.min(680, maxH));
        doc.documentElement.style.background = "#f5f5f7";
        doc.body.style.cssText = "margin:0;background:#f5f5f7;color:#222;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden;";
        doc.body.innerHTML = `
          <div style="height:100vh;display:flex;flex-direction:column;box-sizing:border-box;padding:18px;gap:12px;">
            <div style="flex:0 0 auto;background:white;border:1px solid #d7d7da;border-radius:10px;padding:16px 18px;">
              <div style="font-size:20px;font-weight:700;margin-bottom:8px;">${this.escapeHTML(title)}</div>
              <pre style="margin:0;white-space:pre-wrap;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.45;">${this.escapeHTML(summary)}</pre>
            </div>
            <div style="flex:1 1 auto;min-height:0;background:white;border:1px solid #d7d7da;border-radius:10px;overflow:auto;padding:14px 16px;">
              <pre style="margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.45;">${this.escapeHTML(details || "No additional item-level details.")}</pre>
            </div>
            <div style="flex:0 0 auto;display:flex;justify-content:flex-end;gap:8px;">
              <button id="ss-copy-report" style="padding:7px 13px;">Copy All</button>
              <button id="ss-save-report" style="padding:7px 13px;">Save Report as Text…</button>
              <button id="ss-close-report" style="padding:7px 13px;">Close</button>
            </div>
          </div>`;
        doc.getElementById("ss-copy-report").addEventListener("click", () => {
          Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(fullText);
        });
        doc.getElementById("ss-save-report").addEventListener("click", () => {
          this.saveTextReport(reportWin, title, fullText).catch(e => this.fail(reportWin, e));
        });
        doc.getElementById("ss-close-report").addEventListener("click", () => reportWin.close());
      } catch (e) { Zotero.logError(e); }
    };
    if (reportWin.document?.readyState === "complete") render();
    else reportWin.addEventListener("load", render, { once: true });
    return reportWin;
  },
  async enlargeProgressWindow(progress, preferredWidth = 840, minHeight = 240, maxWidth = 1040, maxHeight = 720) {
    // Track every open progress window so an exception cannot leave stale
    // windows stacked on screen.
    this.activeProgressWindows.add(progress);
    try {
      let popup = null;
      for (let i = 0; i < 40; i++) {
        popup = progress?._window || progress?.window || progress?._progressWindow || null;
        if (popup && !popup.closed && popup.document) break;
        await Zotero.Promise.delay(50);
      }
      if (!popup || popup.closed) return;

      const fit = () => {
        try {
          if (popup.closed) return;
          const screen = popup.screen || {};
          const availableWidth = Number(screen.availWidth) || preferredWidth;
          const availableHeight = Number(screen.availHeight) || maxHeight;
          const widthLimit = Math.max(520, Math.min(maxWidth, Math.floor(availableWidth * 0.88)));
          const heightLimit = Math.max(220, Math.min(maxHeight, Math.floor(availableHeight * 0.78)));
          const targetWidth = Math.min(widthLimit, Math.max(620, preferredWidth));
          const doc = popup.document;
          const root = doc?.documentElement;
          const body = doc?.body || root;
          if (!root || !body) return;

          root.style.width = `${targetWidth}px`;
          root.style.minWidth = `${targetWidth}px`;
          root.style.maxWidth = `${widthLimit}px`;
          root.style.height = 'auto';
          root.style.minHeight = '0';
          root.style.maxHeight = 'none';
          root.style.overflow = 'hidden';
          body.style.height = 'auto';
          body.style.minHeight = '0';
          body.style.maxHeight = 'none';
          body.style.overflowY = 'visible';
          body.style.overflowX = 'hidden';

          const contentHeight = Math.max(
            Number(root.scrollHeight) || 0,
            Number(body.scrollHeight) || 0,
            Number(root.getBoundingClientRect?.().height) || 0,
            Number(body.getBoundingClientRect?.().height) || 0
          );
          const chromeHeight = Math.max(28, (popup.outerHeight || 0) - (popup.innerHeight || 0));
          // Zotero's native ProgressWindow can under-report scrollHeight when a
          // XUL label wraps. Add a conservative text-based estimate so wrapped
          // completion/status messages still enlarge the outer window.
          const visibleText = String(body.textContent || root.textContent || "").replace(/\s+/g, " ").trim();
          const charsPerLine = Math.max(24, Math.floor((targetWidth - 150) / 13));
          const estimatedLines = visibleText
            ? Math.max(1, Math.ceil(visibleText.length / charsPerLine))
            : 1;
          const estimatedContentHeight = 84 + estimatedLines * 34;
          const desiredHeight = Math.max(
            minHeight,
            Math.ceil(contentHeight + chromeHeight + 24),
            Math.ceil(estimatedContentHeight + chromeHeight)
          );
          const finalHeight = Math.min(heightLimit, desiredHeight);
          const innerTargetHeight = Math.max(120, finalHeight - chromeHeight);

          // Give the XUL document an explicit inner height as well as resizing
          // the outer window. On macOS, resizeTo() alone can be ignored when the
          // anonymous ProgressWindow content still advertises a smaller height.
          root.style.height = `${innerTargetHeight}px`;
          root.style.minHeight = `${innerTargetHeight}px`;
          root.style.maxHeight = `${Math.max(innerTargetHeight, heightLimit - chromeHeight)}px`;
          body.style.height = `${innerTargetHeight}px`;
          body.style.minHeight = `${innerTargetHeight}px`;
          body.style.maxHeight = `${Math.max(150, heightLimit - chromeHeight - 12)}px`;
          body.style.overflowY = desiredHeight > heightLimit ? 'auto' : 'visible';

          try {
            root.setAttribute('width', String(targetWidth));
            root.setAttribute('height', String(innerTargetHeight));
          } catch (e) {}

          const applySize = () => {
            try {
              if (!popup.closed) popup.resizeTo(targetWidth, finalHeight);
            } catch (e) {}
          };
          applySize();
          // Multiple post-layout passes are needed for wrapped labels and final
          // completion text in Zotero's native macOS progress windows.
          popup.setTimeout(applySize, 0);
          popup.setTimeout(applySize, 50);
          popup.setTimeout(applySize, 150);
        } catch (e) {
          Zotero.logError(e);
        }
      };

      fit();
      if (!popup.__storscanMutationObserver && popup.MutationObserver && popup.document?.documentElement) {
        const observer = new popup.MutationObserver(() => {
          try {
            if (popup.__storscanFitTimer) popup.clearTimeout(popup.__storscanFitTimer);
            popup.__storscanFitTimer = popup.setTimeout(fit, 20);
          } catch (e) {}
        });
        observer.observe(popup.document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['style', 'class', 'value', 'label']
        });
        popup.__storscanMutationObserver = observer;
      }
      if (!popup.__storscanFitInterval) popup.__storscanFitInterval = popup.setInterval(fit, 100);
      popup.addEventListener('unload', () => {
        this.activeProgressWindows.delete(progress);
        try { popup.__storscanMutationObserver?.disconnect(); } catch (e) {}
        try { if (popup.__storscanFitInterval) popup.clearInterval(popup.__storscanFitInterval); } catch (e) {}
        try { if (popup.__storscanFitTimer) popup.clearTimeout(popup.__storscanFitTimer); } catch (e) {}
      }, { once: true });
    } catch (e) {
      this.activeProgressWindows.delete(progress);
      Zotero.logError(e);
    }
  },


  async finishProgress(progress, line, openingReport = true) {
    try {
      if (line) {
        try { line.setProgress(100); } catch (e) {}
        try { line.setText(openingReport ? "Completed\nOpening report..." : "Completed"); } catch (e) {}
      }
      // Let Zotero paint the short final state, then close the transient
      // progress window before opening any report. This prevents wrapped
      // summaries from being clipped and avoids stale windows stacking.
      await Zotero.Promise.delay(120);
    } finally {
      try { progress?.close(); } catch (e) {}
      try {
        const popup = progress?._window || progress?.window || progress?._progressWindow || null;
        if (popup && !popup.closed) popup.close();
      } catch (e) {}
      this.activeProgressWindows.delete(progress);
    }
  },

  async finishProgressState(progress, line, message = "Completed") {
    try {
      if (line) {
        try { line.setProgress(100); } catch (e) {}
        try { line.setText(message); } catch (e) {}
      }
      await Zotero.Promise.delay(140);
    } finally {
      try { progress?.close(); } catch (e) {}
      try {
        const popup = progress?._window || progress?.window || progress?._progressWindow || null;
        if (popup && !popup.closed) popup.close();
      } catch (e) {}
      this.activeProgressWindows.delete(progress);
    }
  },

  getBaseDirectory(required = true) {
    let base = "";
    try { base = Zotero.Prefs.get("baseAttachmentPath") || ""; } catch (e) {}
    if (base && typeof base !== "string" && base.path) base = base.path;
    if (base) base = base.replace(/[\\/]+$/, "");
    if (required && !base) throw new Error("Zotero's Linked Attachment Base Directory is not set. Set it in Zotero Settings > Advanced > Files and Folders.");
    return base;
  },
  async ensureBaseDirectory() {
    const base = this.getBaseDirectory(true);
    if (!(await IOUtils.exists(base))) throw new Error(`The Linked Attachment Base Directory does not exist or is unavailable:\n${base}`);
    const stat = await IOUtils.stat(base);
    if (stat.type !== "directory") throw new Error(`The Linked Attachment Base Directory is not a folder:\n${base}`);
    return base;
  },
  async showBaseDirectory(win) {
    const base = await this.ensureBaseDirectory();
    this.alert(win, "StorScan", `Zotero Linked Attachment Base Directory:\n\n${base}\n\nThis folder is now the authoritative root used by StorScan.`);
  },
  async searchIDs(attachmentOnly) {
    const search = new Zotero.Search(); search.libraryID = Zotero.Libraries.userLibraryID; search.addCondition("deleted", "false");
    if (attachmentOnly) search.addCondition("itemType", "is", "attachment");
    const ids = await search.search(); return Array.isArray(ids) ? ids : [];
  },
  async getAttachments() {
    const ids = await this.searchIDs(true);
    const items = await Zotero.Items.getAsync(ids);
    return (items || []).filter(x => x && x.isAttachment && x.isAttachment());
  },
  async exists(path) { try { return !!path && await IOUtils.exists(path); } catch (e) { return false; } },
  updateTag(item, tag, shouldHave) {
    const has = item.hasTag(tag); if (shouldHave && !has) { item.addTag(tag); return true; }
    if (!shouldHave && has) { item.removeTag(tag); return true; } return false;
  },
  linkKind(item) {
    const m = Number(item.attachmentLinkMode);
    if (m === Zotero.Attachments.LINK_MODE_LINKED_URL) return "url";
    if (m === Zotero.Attachments.LINK_MODE_LINKED_FILE) return "linked";
    if (m === Zotero.Attachments.LINK_MODE_IMPORTED_FILE || m === Zotero.Attachments.LINK_MODE_IMPORTED_URL) return "stored";
    return "other";
  },

  async scan(win, quiet = false) {
    if (this.running) throw new Error("StorScan is already running.");
    this.running = true;
    const progress = new Zotero.ProgressWindow({ closeOnClick: false }); progress.changeHeadline("StorScan");
    const line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", "Finding attachments..."); progress.show(); await this.enlargeProgressWindow(progress);
    const c = { checked:0, broken:0, brokenLinked:0, brokenStored:0, linkedPresent:0, storedPresent:0, linkedURL:0, duplicateAttachments:0, duplicateParents:0, standalone:0, missingParent:0, itemsWithoutAttachments:0, attachmentRecordsUpdated:0, parentRecordsUpdated:0, errors:0 };
    try {
      const attachments = await this.getAttachments();
      const duplicateCounts = new Map(), parentStatus = new Map();
      for (const item of attachments) {
        const parentID = item.parentItemID || null; if (!parentID || this.linkKind(item) === "url") continue;
        const key = `${parentID}\u0000${item.attachmentContentType || ""}`; duplicateCounts.set(key, (duplicateCounts.get(key)||0)+1);
        if (!parentStatus.has(parentID)) parentStatus.set(parentID, {broken:false, duplicate:false});
      }
      for (let i=0;i<attachments.length;i++) {
        const item = attachments[i]; c.checked++; line.setText(`Checking attachment ${i+1} of ${attachments.length}`); line.setProgress(Math.round((i+1)/Math.max(1,attachments.length)*80));
        try {
          await item.loadAllData(); const kind = this.linkKind(item); let broken = false;
          if (kind === "url") c.linkedURL++; else {
            let path = null; try { path = await item.getFilePathAsync(); } catch(e) {}
            broken = !(path && await this.exists(path));
            if (broken) { c.broken++; if (kind === "linked") c.brokenLinked++; else if (kind === "stored") c.brokenStored++; }
            else { if (kind === "linked") c.linkedPresent++; else if (kind === "stored") c.storedPresent++; }
          }
          const parentID = item.parentItemID || null, key = parentID ? `${parentID}\u0000${item.attachmentContentType || ""}` : null;
          const duplicate = key ? (duplicateCounts.get(key)||0)>1 : false; if (duplicate) c.duplicateAttachments++;
          const standalone = !parentID; if (standalone) c.standalone++;
          let missingParent = false; if (parentID) missingParent = !(await Zotero.Items.getAsync(parentID)); if (missingParent) c.missingParent++;
          let changed = false; changed = this.updateTag(item,"#broken_attachments",broken)||changed; changed=this.updateTag(item,"#multiple_attachments_of_same_type",duplicate)||changed; changed=this.updateTag(item,"#nosource",standalone||missingParent)||changed;
          if (changed) { await item.saveTx(); c.attachmentRecordsUpdated++; }
          if (parentID && parentStatus.has(parentID)) { const s=parentStatus.get(parentID); s.broken ||= broken; s.duplicate ||= duplicate; }
        } catch(e) { c.errors++; Zotero.logError(e); }
        if (i && i%100===0) await Zotero.Promise.delay(0);
      }
      c.duplicateParents=[...parentStatus.values()].filter(x=>x.duplicate).length;
      const all = await Zotero.Items.getAsync(await this.searchIDs(false));
      const regular=(all||[]).filter(x=>x&&x.isRegularItem&&x.isRegularItem()&&!x.deleted);
      for (let i=0;i<regular.length;i++) {
        const item=regular[i]; try {
          const noAttachments=!(item.getAttachments?.(false)||[]).length; if(noAttachments)c.itemsWithoutAttachments++;
          const s=parentStatus.get(item.id)||{broken:false,duplicate:false}; let changed=false;
          changed=this.updateTag(item,"#broken_attachments",s.broken)||changed; changed=this.updateTag(item,"#multiple_attachments_of_same_type",s.duplicate)||changed; changed=this.updateTag(item,"#nosource",noAttachments)||changed;
          if(changed){await item.saveTx();c.parentRecordsUpdated++;}
        }catch(e){c.errors++;Zotero.logError(e);} if(i&&i%100===0)await Zotero.Promise.delay(0);
      }
      if (!quiet) await this.finishProgress(progress, line, true);
      else await this.finishProgress(progress, line, false);
      if (!quiet) this.showReport(win, "StorScan — Library Scan", `Attachment records checked: ${c.checked}\nBroken attachment files: ${c.broken}\nWorking linked files: ${c.linkedPresent}\nWorking stored files: ${c.storedPresent}\nErrors: ${c.errors}`, `Broken linked files: ${c.brokenLinked}\nBroken stored files: ${c.brokenStored}\nLinked web attachments ignored: ${c.linkedURL}\nDuplicate-type attachments: ${c.duplicateAttachments}\nParent items with duplicate types: ${c.duplicateParents}\nStandalone attachments: ${c.standalone}\nBibliographic items without attachments: ${c.itemsWithoutAttachments}\nAttachment records updated: ${c.attachmentRecordsUpdated}\nParent records updated: ${c.parentRecordsUpdated}`);
      return c;
    } finally { this.running=false; }
  },

  async recursiveFiles(root) {
    const out=[]; const stack=[root];
    while(stack.length){const dir=stack.pop(); let kids=[]; try{kids=await IOUtils.getChildren(dir);}catch(e){continue;}
      for(const p of kids){try{const s=await IOUtils.stat(p); if(s.type==="directory") stack.push(p); else if(s.type==="regular") out.push({path:p,size:s.size});}catch(e){}}
      if(out.length && out.length%500===0) await Zotero.Promise.delay(0);
    }
    return out;
  },
  sha256(path) {
    return new Promise((resolve,reject)=>{try{
      const file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile); file.initWithPath(path);
      const stream=Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream); stream.init(file,0x01,0o444,0);
      const hash=Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash); hash.init(hash.SHA256); hash.updateFromStream(stream,-1); stream.close();
      const raw=hash.finish(false); resolve(Array.from(raw,c=>c.charCodeAt(0).toString(16).padStart(2,"0")).join(""));
    }catch(e){reject(e);}});
  },
  async exactDuplicateGroups(base, progressLine=null) {
    const files=(await this.recursiveFiles(base)).filter(f=>/\.pdf$/i.test(f.path));
    const bySize=new Map(); for(const f of files){if(!bySize.has(f.size))bySize.set(f.size,[]);bySize.get(f.size).push(f);}
    const candidates=[...bySize.values()].filter(g=>g.length>1).flat(); const byHash=new Map();
    for(let i=0;i<candidates.length;i++){const f=candidates[i]; if(progressLine){progressLine.setText(`Hashing possible duplicate ${i+1} of ${candidates.length}`);progressLine.setProgress(Math.round((i+1)/Math.max(1,candidates.length)*100));}
      try{f.hash=await this.sha256(f.path); const k=`${f.size}:${f.hash}`; if(!byHash.has(k))byHash.set(k,[]);byHash.get(k).push(f);}catch(e){Zotero.logError(e);} if(i&&i%25===0)await Zotero.Promise.delay(0);
    }
    return [...byHash.values()].filter(g=>g.length>1);
  },
  canonicalFile(group) {
    const score=p=>{const n=PathUtils.filename(p); let s=0; if(!/\s\(\d+\)(?=\.[^.]+$)/.test(n))s+=1000; s-=n.length; s-=p.length/1000; return s;};
    return [...group].sort((a,b)=>score(b.path)-score(a.path)||a.path.localeCompare(b.path))[0];
  },
  async linkedAttachmentMap() {
    const map=new Map();
    for(const a of await this.getAttachments()) if(this.linkKind(a)==="linked") {let p=null;try{p=await a.getFilePathAsync();}catch(e){} if(p){const k=p.replace(/\\/g,"/");if(!map.has(k))map.set(k,[]);map.get(k).push(a);}}
    return map;
  },
  async previewCleanup(win) {
    const base=await this.ensureBaseDirectory();
    const progress=new Zotero.ProgressWindow({closeOnClick:false});progress.changeHeadline("StorScan");const line=new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png","Auditing cleanup candidates...");progress.show(); await this.enlargeProgressWindow(progress);
    try{
      const attachments=await this.getAttachments(); let broken=0,stored=0,linked=0;
      for(let i=0;i<attachments.length;i++){const a=attachments[i],kind=this.linkKind(a);if(kind==="url")continue;let p=null;try{p=await a.getFilePathAsync();}catch(e){} if(!(p&&await this.exists(p)))broken++;else if(kind==="stored")stored++;else if(kind==="linked")linked++;}
      const groups=await this.exactDuplicateGroups(base,line); const duplicateFiles=groups.reduce((n,g)=>n+g.length-1,0); const duplicateBytes=groups.reduce((n,g)=>n+(g.length-1)*g[0].size,0);
      await this.finishProgress(progress, line, true);
      this.showReport(win, "StorScan — Cleanup Preview", `Broken attachment records removable: ${broken}\nWorking stored PDFs needing migration: ${stored}\nWorking linked PDFs: ${linked}\nExact duplicate groups: ${groups.length}\nRedundant duplicate files: ${duplicateFiles}\nPotential space recovered: ${(duplicateBytes/1024/1024).toFixed(1)} MB`, `Linked Attachment Base Directory:\n${base}\n\nNo files or records were changed.`);
    }catch(e){progress.startCloseTimer(2000);throw e;}
  },
  async removeBrokenRecords(win) {
    if (this.running) throw new Error("StorScan is already running.");
    this.running = true;
    const progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("StorScan — Remove Broken Links");
    const line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", "Finding broken attachment records...");
    progress.show(); await this.enlargeProgressWindow(progress);
    try {
      const attachments = await this.getAttachments();
      const broken = [];
      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        line.setText(`Checking attachment ${i + 1} of ${attachments.length}`);
        line.setProgress(Math.round(((i + 1) / Math.max(1, attachments.length)) * 40));
        if (this.linkKind(a) !== "url") {
          let p = null;
          try { p = await a.getFilePathAsync(); } catch (e) {}
          if (!(p && await this.exists(p))) broken.push(a);
        }
        if (i && i % 100 === 0) await Zotero.Promise.delay(0);
      }
      if (!broken.length) {
        await this.finishProgressState(progress, line, "Completed\nNo changes were necessary.");
        return this.alert(win, "StorScan", "No broken attachment records were found.");
      }
      if (!this.confirm(win, "Remove Broken Attachment Records", `Remove ${broken.length} attachment records whose files do not exist?

Parent bibliographic items and all working attachments will remain untouched. This cannot restore missing files.`)) {
        await this.finishProgressState(progress, line, "Operation cancelled."); return;
      }
      let removed = 0, failed = 0;
      for (let i = 0; i < broken.length; i++) {
        const a = broken[i];
        line.setText(`Removing broken record ${i + 1} of ${broken.length}`);
        line.setProgress(40 + Math.round(((i + 1) / Math.max(1, broken.length)) * 60));
        try { await a.eraseTx(); removed++; } catch (e) { failed++; Zotero.logError(e); }
        if (i && i % 50 === 0) await Zotero.Promise.delay(0);
      }
      await this.finishProgress(progress, line, true);
      this.showReport(win, "StorScan — Remove Broken Links", `Broken attachment records removed: ${removed}
Failed: ${failed}`, broken.map(a => `Attachment ${a.id}: ${a.getField("title") || "Untitled attachment"}`).join("\n"));
    } finally { this.running = false; }
  },
  async consolidateDuplicates(win) {
    if (this.running) throw new Error("StorScan is already running.");
    this.running = true;
    const base = await this.ensureBaseDirectory();
    let progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("StorScan — Base Duplicates");
    let line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", "Finding exact duplicates...");
    progress.show(); await this.enlargeProgressWindow(progress);
    try {
      const groups = await this.exactDuplicateGroups(base, line);
      const redundant = groups.reduce((n, g) => n + g.length - 1, 0);
      if (!redundant) {
        await this.finishProgressState(progress, line, "Completed\nNo changes were necessary.");
        return this.alert(win, "StorScan", "No byte-for-byte duplicate PDFs were found in the Linked Attachment Base Directory.");
      }

      // Close the audit progress window before showing a modal prompt. On macOS,
      // reusing the same ProgressWindow after the prompt can leave it blank.
      try { progress.close(); } catch (e) {}
      progress = null; line = null;

      if (!this.confirm(win, "Consolidate Exact Dropbox Duplicates", `Found ${groups.length} exact duplicate groups containing ${redundant} redundant PDF files.

The plugin will keep one canonical file per group, repoint linked Zotero attachments to it, remove redundant attachment records under the same parent, and then delete redundant files.

Continue?`)) {
        return;
      }

      // Use a fresh progress window for the destructive phase and yield once so
      // Zotero has time to paint it before loading thousands of attachment records.
      progress = new Zotero.ProgressWindow({ closeOnClick: false });
      progress.changeHeadline("StorScan — Base Duplicates");
      line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", `Preparing to consolidate ${redundant} duplicate files...`);
      line.setProgress(0);
      progress.show(); await this.enlargeProgressWindow(progress);
      await Zotero.Promise.delay(50);

      line.setText("Loading linked attachment records...");
      await Zotero.Promise.delay(0);
      const links = await this.linkedAttachmentMap();
      await Zotero.Promise.delay(0);

      let deletedFiles = 0, relinked = 0, removedRecords = 0, failed = 0, done = 0;
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        const canonical = this.canonicalFile(group);
        const canonicalPath = canonical.path.replace(/\\/g, "/");
        for (const extra of group) {
          if (extra.path === canonical.path) continue;
          done++;
          const pct = Math.round((done / Math.max(1, redundant)) * 100);
          line.setText(`Consolidating duplicate ${done} of ${redundant}: ${PathUtils.filename(extra.path)}`);
          line.setProgress(pct);
          await Zotero.Promise.delay(0);

          const extraPath = extra.path.replace(/\\/g, "/");
          const atts = links.get(extraPath) || [];
          try {
            for (const att of atts) {
              const parent = att.parentItemID;
              const existing = (links.get(canonicalPath) || []).find(x => x.parentItemID === parent);
              if (existing) {
                await att.eraseTx();
                removedRecords++;
              }
              else {
                await att.relinkAttachmentFile(canonical.path);
                relinked++;
                if (!links.has(canonicalPath)) links.set(canonicalPath, []);
                links.get(canonicalPath).push(att);
              }
            }
            if (await this.exists(extra.path)) {
              await IOUtils.remove(extra.path);
              deletedFiles++;
            }
          }
          catch (e) {
            failed++;
            Zotero.logError(e);
          }
          await Zotero.Promise.delay(0);
        }
      }
      await this.finishProgress(progress, line, true);
      this.showReport(win, "StorScan — Consolidate Base Duplicates", `Exact duplicate files deleted: ${deletedFiles}
Linked attachments repointed: ${relinked}
Redundant attachment records removed: ${removedRecords}
Failures: ${failed}`, groups.map((group, index) => { const canonical = this.canonicalFile(group); return `Group ${index + 1}
  Kept: ${canonical.path}
  Duplicates:
${group.filter(x => x.path !== canonical.path).map(x => `    ${x.path}`).join("\n")}`; }).join("\n\n"));
    }
    finally {
      this.running = false;
    }
  },
  async consolidateItemDuplicates(win) {
    if (this.running) throw new Error("StorScan is already running.");
    this.running = true;
    let progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("StorScan — Item PDFs");
    let line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", "Finding linked PDF attachments...");
    progress.show(); await this.enlargeProgressWindow(progress);
    try {
      const attachments = await this.getAttachments();
      const byParent = new Map();
      const pathRefs = new Map();
      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        line.setText(`Checking linked PDF ${i + 1} of ${attachments.length}`);
        line.setProgress(Math.round(((i + 1) / Math.max(1, attachments.length)) * 25));
        if (this.linkKind(a) !== "linked" || a.attachmentContentType !== "application/pdf" || !a.parentItemID) continue;
        let path = null;
        try { path = await a.getFilePathAsync(); } catch (e) {}
        if (!(path && await this.exists(path))) continue;
        const key = path.replace(/\\/g, "/");
        if (!pathRefs.has(key)) pathRefs.set(key, []);
        pathRefs.get(key).push(a);
        if (!byParent.has(a.parentItemID)) byParent.set(a.parentItemID, []);
        const st = await IOUtils.stat(path);
        byParent.get(a.parentItemID).push({ att: a, path, key, size: st.size });
        if (i && i % 100 === 0) await Zotero.Promise.delay(0);
      }

      const duplicateGroups = [];
      let parentIndex = 0;
      for (const [parentID, list] of byParent) {
        parentIndex++;
        if (list.length < 2) continue;
        line.setText(`Comparing PDFs for item ${parentIndex} of ${byParent.size}`);
        line.setProgress(25 + Math.round((parentIndex / Math.max(1, byParent.size)) * 35));
        const bySize = new Map();
        for (const x of list) {
          if (!bySize.has(x.size)) bySize.set(x.size, []);
          bySize.get(x.size).push(x);
        }
        for (const sameSize of bySize.values()) {
          if (sameSize.length < 2) continue;
          const byHash = new Map();
          for (const x of sameSize) {
            try {
              x.hash = await this.sha256(x.path);
              if (!byHash.has(x.hash)) byHash.set(x.hash, []);
              byHash.get(x.hash).push(x);
            } catch (e) { Zotero.logError(e); }
          }
          for (const g of byHash.values()) if (g.length > 1) duplicateGroups.push({ parentID, items: g });
        }
        if (parentIndex % 20 === 0) await Zotero.Promise.delay(0);
      }

      const redundant = duplicateGroups.reduce((n, g) => n + g.items.length - 1, 0);
      if (!redundant) {
        await this.finishProgressState(progress, line, "Completed\nNo changes were necessary.");
        return this.alert(win, "StorScan", "No byte-for-byte duplicate linked PDFs were found under the same bibliographic item.");
      }

      try { progress.close(); } catch (e) {}
      progress = null; line = null;
      if (!this.confirm(win, "Consolidate Duplicate PDFs Per Zotero Item", `Found ${duplicateGroups.length} duplicate sets containing ${redundant} redundant linked PDF attachments.

For each set, the plugin will keep one linked attachment, remove the redundant Zotero attachment records, and delete a redundant Dropbox file only when no other Zotero record points to it.

Continue?`)) return;

      progress = new Zotero.ProgressWindow({ closeOnClick: false });
      progress.changeHeadline("StorScan — Item PDFs");
      line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", `Preparing to consolidate ${redundant} duplicate attachments...`);
      line.setProgress(0);
      progress.show(); await this.enlargeProgressWindow(progress);
      await Zotero.Promise.delay(50);

      let removedRecords = 0, deletedFiles = 0, retainedSharedFiles = 0, failed = 0, done = 0;
      for (const group of duplicateGroups) {
        const canonicalFile = this.canonicalFile(group.items.map(x => ({ path: x.path, size: x.size })));
        const canonical = group.items.find(x => x.path === canonicalFile.path) || group.items[0];
        for (const extra of group.items) {
          if (extra.att.id === canonical.att.id) continue;
          done++;
          line.setText(`Removing duplicate attachment ${done} of ${redundant}: ${PathUtils.filename(extra.path)}`);
          line.setProgress(Math.round((done / Math.max(1, redundant)) * 100));
          await Zotero.Promise.delay(0);
          try {
            const refs = pathRefs.get(extra.key) || [];
            await extra.att.eraseTx();
            removedRecords++;
            const remainingRefs = refs.filter(a => a.id !== extra.att.id && !a.deleted);
            pathRefs.set(extra.key, remainingRefs);
            if (extra.key !== canonical.key) {
              if (!remainingRefs.length && await this.exists(extra.path)) {
                await IOUtils.remove(extra.path);
                deletedFiles++;
              } else if (remainingRefs.length) {
                retainedSharedFiles++;
              }
            }
          } catch (e) {
            failed++;
            Zotero.logError(e);
          }
          await Zotero.Promise.delay(0);
        }
      }
      await this.finishProgress(progress, line, true);
      this.showReport(win, "StorScan — Consolidate Item PDFs", `Duplicate attachment records removed: ${removedRecords}
Redundant files deleted: ${deletedFiles}
Shared files retained: ${retainedSharedFiles}
Failures: ${failed}`, duplicateGroups.map((group, index) => `Group ${index + 1} — Parent item ${group.parentID}
${group.items.map(x => `  ${x.path}`).join("\n")}`).join("\n\n"));
    } finally {
      this.running = false;
    }
  },

  pathKey(path) { return String(path || "").replace(/\\/g, "/").replace(/\/+$/, ""); },
  isInsideBase(path, base) {
    const p = this.pathKey(path);
    const b = this.pathKey(base);
    return !!p && !!b && (p === b || p.startsWith(b + "/"));
  },
  async removeFileIfUnreferenced(path, excludingID = null) {
    const key = this.pathKey(path);
    const attachments = await this.getAttachments();
    for (const a of attachments) {
      if (excludingID && a.id === excludingID) continue;
      if (this.linkKind(a) !== "linked") continue;
      let p = null; try { p = await a.getFilePathAsync(); } catch (e) {}
      if (this.pathKey(p) === key) return false;
    }
    if (await this.exists(path)) await IOUtils.remove(path);
    return true;
  },


  normalizeDOI(value) {
    return String(value || "").trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  },
  itemSearchTerms(parent) {
    const title = String(parent.getField("title") || "").trim();
    const creators = parent.getCreators?.() || [];
    const creator = creators.find(c => c.creatorType === "author") || creators[0] || {};
    const author = String(creator.lastName || creator.name || "").trim();
    const year = this.year(parent) === "n.d." ? "" : this.year(parent);
    return { title, author, year, doi: this.normalizeDOI(parent.getField("DOI") || ""), isbn: String(parent.getField("ISBN") || "").replace(/[^0-9Xx]/g, "") };
  },
  async getUnpaywallEmail(win) {
    let email = String(this.getPref("unpaywallEmail", "")).trim();
    if (email) return email;
    const value = { value: "" };
    const ok = Services.prompt.prompt(win, "StorScan — Unpaywall", "Enter an email address for polite use of the Unpaywall API. StorScan stores it only in Zotero preferences.", value, null, {});
    if (!ok || !String(value.value || "").trim()) return "";
    email = String(value.value).trim();
    this.setPref("unpaywallEmail", email);
    return email;
  },
  async downloadOpenAccessPDF(url, destination) {
    const response = await Zotero.HTTP.request("GET", url, {
      responseType: "arraybuffer",
      followRedirects: true,
      timeout: 60000
    });
    const data = new Uint8Array(response.response);
    if (data.length < 5 || String.fromCharCode(...data.slice(0, 5)) !== "%PDF-") {
      throw new Error("The open-access source did not return a PDF file.");
    }
    await IOUtils.write(destination, data);
  },
  async importLinkedCopy(parent, sourcePath, options = {}) {
    const base = await this.ensureBaseDirectory();
    const extMatch = PathUtils.filename(sourcePath).match(/(\.[A-Za-z0-9]{2,8})$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : ".pdf";
    const targetDir = PathUtils.join(base, this.creator(parent));
    await IOUtils.makeDirectory(targetDir, { createAncestors: true, ignoreExisting: true });
    const baseName = this.filename(parent).replace(/\.pdf$/i, ext);
    let target = PathUtils.join(targetDir, baseName);
    if (await this.exists(target)) {
      const same = (await IOUtils.stat(sourcePath)).size === (await IOUtils.stat(target)).size
        && await this.sha256(sourcePath) === await this.sha256(target);
      if (!same) {
        const stem = target.slice(0, -ext.length);
        let found = null;
        for (let n = 2; n < 1000; n++) {
          const candidate = `${stem} (${n})${ext}`;
          if (!(await this.exists(candidate))) { found = candidate; break; }
        }
        if (!found) throw new Error("Could not create a unique destination filename.");
        target = found;
      }
    }
    let copied = false;
    if (!(await this.exists(target))) {
      await IOUtils.copy(sourcePath, target, { noOverwrite: true });
      copied = true;
      const [src, dst] = await Promise.all([IOUtils.stat(sourcePath), IOUtils.stat(target)]);
      if (src.size !== dst.size || await this.sha256(sourcePath) !== await this.sha256(target)) {
        try { await IOUtils.remove(target); } catch (e) {}
        throw new Error("Copied-file verification failed.");
      }
    }
    let attachment = null;
    try {
      attachment = await Zotero.Attachments.linkFromFile({
        file: target,
        libraryID: parent.libraryID,
        parentItemID: parent.id,
        saveOptions: { skipSelect: true }
      });
      if (typeof attachment.renameAttachmentFile === "function") {
        try { await attachment.renameAttachmentFile(); } catch (e) { Zotero.logError(e); }
      }
      const reloaded = await Zotero.Items.getAsync(attachment.id);
      try { await reloaded.reload(); } catch (e) {}
      const finalPath = await reloaded.getFilePathAsync();
      if (!(finalPath && await this.exists(finalPath) && this.isInsideBase(finalPath, base))) {
        throw new Error("The imported attachment could not be verified inside the base directory.");
      }
      const title = PathUtils.filename(finalPath).replace(/\.[^.]+$/, "");
      reloaded.setField("title", title);
      await reloaded.saveTx();
      return { attachment: reloaded, path: finalPath, copied };
    } catch (e) {
      if (attachment) { try { await attachment.eraseTx(); } catch (_) {} }
      if (copied && await this.exists(target)) { try { await IOUtils.remove(target); } catch (_) {} }
      throw e;
    }
  },
  async findLegalFullText(win) {
    if (this.running) throw new Error("StorScan is already running.");
    this.running = true;
    const progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("StorScan — Find Legal Full Text");
    const line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", "Reading selected bibliographic item...");
    line.setProgress(0);
    progress.show(); await this.enlargeProgressWindow(progress, 880, 260, 1080, 700);
    let tempPath = null;
    try {
      const parent = await this.selectedRegularItem(win);
      const terms = this.itemSearchTerms(parent);
      const title = terms.title || `Item ${parent.id}`;
      line.setText(`Checking identifiers\n${title}`);
      line.setProgress(10);
      if (!terms.doi) {
        throw new Error("This item has no DOI. Use Open Library Search for books, or Attach Local Copy for a file you already obtained legally.");
      }
      if (this.getPref("enableUnpaywall", true) === false) throw new Error("Unpaywall is disabled in StorScan preferences.");
      const email = await this.getUnpaywallEmail(win);
      if (!email) throw new Error("An email address is required to query Unpaywall.");
      line.setText(`Querying Unpaywall\n${terms.doi}`);
      line.setProgress(25);
      const endpoint = `https://api.unpaywall.org/v2/${encodeURIComponent(terms.doi)}?email=${encodeURIComponent(email)}`;
      const response = await Zotero.HTTP.request("GET", endpoint, { responseType: "json", timeout: 30000 });
      const record = response.response;
      const locations = [record?.best_oa_location, ...(record?.oa_locations || [])].filter(Boolean);
      const candidate = locations.find(x => x.url_for_pdf) || null;
      if (!candidate) {
        await this.finishProgressState(progress, line, "Completed\nNo open full text found.");
        return this.alert(win, "StorScan — Find Legal Full Text", `No legal open-access PDF was found by Unpaywall for DOI ${terms.doi}.\n\nStorScan did not download or attach anything. Try the publisher page, your library resolver, Open Library Search, or Attach Local Copy.`);
      }
      const host = (() => { try { return new URL(candidate.url_for_pdf).hostname; } catch (e) { return "open-access repository"; } })();
      try { progress.close(); } catch (e) {}
      if (!this.confirm(win, "Import Legal Full Text", `Unpaywall reports an open-access PDF for:\n\n${title}\nDOI: ${terms.doi}\nSource: ${host}\nLicense: ${candidate.license || "not stated"}\n\nDownload, attach, organize into the author folder, rename using Zotero's filename settings, and verify the linked file?`)) return;
      const run = new Zotero.ProgressWindow({ closeOnClick: false });
      run.changeHeadline("StorScan — Import Legal Full Text");
      const status = new run.ItemProgress("chrome://zotero/skin/spinner-16px.png", `Downloading open-access PDF\n${title}`);
      status.setProgress(15);
      run.show(); await this.enlargeProgressWindow(run, 900, 280, 1100, 720);
      tempPath = PathUtils.join(PathUtils.tempDir, `storscan-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`);
      await this.downloadOpenAccessPDF(candidate.url_for_pdf, tempPath);
      status.setText(`Importing and organizing\n${title}`); status.setProgress(65);
      const imported = await this.importLinkedCopy(parent, tempPath, { source: "Unpaywall" });
      await this.finishProgress(run, status, true);
      this.showReport(win, "StorScan — Find Legal Full Text", `Legal full text imported successfully.\nSource: Unpaywall\nDOI: ${terms.doi}`, `Final linked path:\n${imported.path}`);
    } finally {
      if (tempPath && await this.exists(tempPath)) { try { await IOUtils.remove(tempPath); } catch (e) {} }
      this.running = false;
    }
  },
  async attachLocalCopy(win) {
    if (this.running) throw new Error("StorScan is already running.");
    this.running = true;
    try {
      const parent = await this.selectedRegularItem(win);
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      picker.init(win, "Select a PDF or EPUB to attach", Ci.nsIFilePicker.modeOpen);
      picker.appendFilter("PDF and EPUB files", "*.pdf;*.epub");
      picker.appendFilters(Ci.nsIFilePicker.filterAll);
      const result = await new Promise(resolve => picker.open(resolve));
      if (result !== Ci.nsIFilePicker.returnOK || !picker.file?.path) return;
      const source = picker.file.path;
      if (!/\.(pdf|epub)$/i.test(source)) throw new Error("Select a PDF or EPUB file.");
      const progress = new Zotero.ProgressWindow({ closeOnClick: false });
      progress.changeHeadline("StorScan — Attach Local Copy");
      const line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", `Copying and organizing\n${PathUtils.filename(source)}`);
      line.setProgress(10); progress.show(); await this.enlargeProgressWindow(progress, 880, 260, 1080, 700);
      const imported = await this.importLinkedCopy(parent, source, { source: "local" });
      await this.finishProgress(progress, line, true);
      this.showReport(win, "StorScan — Attach Local Copy", "Local copy attached and verified.", `Final linked path:\n${imported.path}`);
    } finally { this.running = false; }
  },
  async openLibrarySearch(win) {
    const parent = await this.selectedRegularItem(win);
    const terms = this.itemSearchTerms(parent);
    const query = terms.isbn || [terms.title, terms.author, terms.year].filter(Boolean).join(" ");
    if (!query) throw new Error("The selected item does not contain enough metadata for an Open Library search.");
    const url = `https://openlibrary.org/search?q=${encodeURIComponent(query)}`;
    Zotero.launchURL(url);
  },
  async showFullTextSettings(win) {
    const email = String(this.getPref("unpaywallEmail", "")).trim() || "not configured";
    this.alert(win, "StorScan — Full-Text Settings", `Legal full-text sources\n\nUnpaywall: ${this.getPref("enableUnpaywall", true) === false ? "disabled" : "enabled"}\nContact email: ${email}\nOpen Library: enabled as a browser search\n\nEdit these options in Zotero Settings → StorScan.`);
  },

  async selectedRegularItem(win) {
    const pane = win.ZoteroPane || Zotero.getActiveZoteroPane?.();
    const selected = pane?.getSelectedItems?.() || [];
    const parentIDs = new Set();

    for (const item of selected) {
      if (!item || item.deleted) continue;
      if (item.isRegularItem?.()) {
        parentIDs.add(item.id);
        continue;
      }
      let parentID = item.parentItemID || null;
      if (!parentID && item.isAnnotation?.()) {
        try {
          const attachment = await Zotero.Items.getAsync(item.parentItemID);
          parentID = attachment?.parentItemID || null;
        } catch (e) {}
      }
      if (parentID) {
        const parent = await Zotero.Items.getAsync(parentID);
        if (parent?.isRegularItem?.()) parentIDs.add(parent.id);
        else if (parent?.parentItemID) {
          const grandparent = await Zotero.Items.getAsync(parent.parentItemID);
          if (grandparent?.isRegularItem?.()) parentIDs.add(grandparent.id);
        }
      }
    }

    if (parentIDs.size !== 1) {
      throw new Error("Select one bibliographic item or any one of its child attachments, notes, or annotations, then run this command again.");
    }
    return await Zotero.Items.getAsync([...parentIDs][0]);
  },

  async inspectSelectedItem(win) {
    if (this.running) throw new Error("StorScan is already running.");
    this.running = true;
    try {
      const base = await this.ensureBaseDirectory();
      const parent = await this.selectedRegularItem(win);
      const title = parent.getField("title") || `Item ${parent.id}`;
      let ids = [];
      try { ids = parent.getAttachments(false) || []; } catch (e) {}
      const children = await Zotero.Items.getAsync(ids);
      const targetDir = PathUtils.join(base, this.creator(parent));
      const target = PathUtils.join(targetDir, this.filename(parent));
      const targetKey = this.pathKey(target);
      const rows = [];
      const workingLinkedPDFs = [];

      for (const a of children || []) {
        if (!a || !(a.isAttachment && a.isAttachment())) continue;
        let resolved = null;
        try { resolved = await a.getFilePathAsync(); } catch (e) {}
        let rawPath = "";
        try { rawPath = a.attachmentPath || ""; } catch (e) {}
        const exists = resolved ? await this.exists(resolved) : false;
        const kind = this.linkKind(a);
        const isPDF = !!(a.attachmentContentType === "application/pdf" || (resolved && /\.pdf$/i.test(resolved)) || (rawPath && /\.pdf$/i.test(rawPath)));
        const inside = resolved ? this.isInsideBase(resolved, base) : false;
        const exactTarget = resolved ? this.pathKey(resolved) === targetKey : false;
        if (kind === "linked" && exists && isPDF) {
          workingLinkedPDFs.push({ a, path: resolved, key: this.pathKey(resolved), inside, exactTarget });
        }
        rows.push([
          `Attachment ID: ${a.id}`,
          `Title: ${a.getField?.("title") || "(untitled attachment)"}`,
          `Link mode: ${kind} (${a.attachmentLinkMode})`,
          `Content type: ${a.attachmentContentType || "(none)"}`,
          `Raw attachmentPath: ${rawPath || "(none)"}`,
          `Resolved path: ${resolved || "(none)"}`,
          `File exists: ${exists ? "YES" : "NO"}`,
          `PDF: ${isPDF ? "YES" : "NO"}`,
          `Inside base directory: ${inside ? "YES" : "NO"}`,
          `Exact canonical destination: ${exactTarget ? "YES" : "NO"}`
        ].join("\n"));
      }

      let canonicalReason = "No working linked PDF found";
      let canonicalPath = "(none)";
      if (workingLinkedPDFs.length) {
        const canonical = workingLinkedPDFs.find(x => x.exactTarget)
          || workingLinkedPDFs.find(x => x.inside)
          || workingLinkedPDFs[0];
        canonicalPath = canonical.path;
        canonicalReason = canonical.exactTarget
          ? "Exact canonical path already exists"
          : canonical.inside
            ? "First working linked PDF already inside the base directory"
            : "First working linked PDF (all are outside the base directory)";
      }

      const report = [
        `Bibliographic item:\n${title}`,
        `Item ID: ${parent.id}`,
        `Base directory:\n${base}`,
        `Canonical destination:\n${target}`,
        `Working linked PDFs found: ${workingLinkedPDFs.length}`,
        `Current canonical choice:\n${canonicalPath}`,
        `Why chosen:\n${canonicalReason}`,
        rows.length ? `Attachments:\n\n${rows.join("\n\n------------------------------\n\n")}` : "Attachments: none"
      ].join("\n\n");

      this.showReport(win, "StorScan — Inspect Selected Item", `Bibliographic item: ${parent.getField("title") || "Untitled"}
Item ID: ${parent.id}`, report);
    } finally {
      this.running = false;
    }
  },

  async linkedPDFsForParent(parent) {
    let ids = [];
    try { ids = parent.getAttachments(false) || []; } catch (e) {}
    const children = await Zotero.Items.getAsync(ids);
    const out = [];
    for (const a of children || []) {
      if (!a || !(a.isAttachment && a.isAttachment()) || this.linkKind(a) !== "linked") continue;
      let path = null;
      try { path = await a.getFilePathAsync(); } catch (e) {}
      if (!(path && await this.exists(path))) continue;
      if (!(a.attachmentContentType === "application/pdf" || /\.pdf$/i.test(path))) continue;
      out.push({ a, path, key: this.pathKey(path) });
    }
    return out;
  },

  async normalizeSelectedItem(win) {
    if (this.running) throw new Error("StorScan is already running.");
    this.running = true;
    const progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("StorScan — Normalize Selected Item");
    const line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", "Preparing selected item...");
    line.setProgress(0);
    progress.show(); await this.enlargeProgressWindow(progress, 860, 260);
    try {
      const base = await this.ensureBaseDirectory();
      const parent = await this.selectedRegularItem(win);
      const title = parent.getField("title") || `Item ${parent.id}`;
      line.setText(`Reading attachments\n${title}`);
      line.setProgress(10);
      const pdfs = await this.linkedPDFsForParent(parent);
      if (!pdfs.length) throw new Error("The selected bibliographic item has no working linked PDF attachments.");

      const targetDir = PathUtils.join(base, this.creator(parent));
      const target = PathUtils.join(targetDir, this.filename(parent));
      const targetKey = this.pathKey(target);
      const canonical = pdfs.find(x => x.key === targetKey)
        || pdfs.find(x => this.isInsideBase(x.path, base))
        || pdfs[0];
      const oldPath = canonical.path;
      const oldKey = canonical.key;

      const preview = `Bibliographic item:\n${title}\n\nCurrent linked PDF:\n${oldPath}\n\nCanonical destination:\n${target}\n\nLinked PDFs attached to this item: ${pdfs.length}\n\nStorScan will verify the new file and the persisted Zotero link before removing any obsolete attachment record or old file.`;
      try { progress.close(); } catch (e) {}
      if (!this.confirm(win, "Normalize Selected Zotero Item", preview + "\n\nContinue?")) return;

      const run = new Zotero.ProgressWindow({ closeOnClick: false });
      run.changeHeadline("StorScan — Normalize Selected Item");
      const status = new run.ItemProgress("chrome://zotero/skin/spinner-16px.png", `Preparing\n${title}`);
      status.setProgress(0);
      run.show(); await this.enlargeProgressWindow(run, 860, 280);

      let copied = false;
      let relinked = false;
      let removed = 0;
      let deleted = 0;
      try {
        await IOUtils.makeDirectory(targetDir, { createAncestors: true, ignoreExisting: true });
        status.setText(`Verifying destination\n${PathUtils.filename(target)}`);
        status.setProgress(20);
        await Zotero.Promise.delay(0);

        if (oldKey !== targetKey) {
          if (await this.exists(target)) {
            const [srcStat, dstStat] = await Promise.all([IOUtils.stat(oldPath), IOUtils.stat(target)]);
            if (srcStat.size !== dstStat.size || await this.sha256(oldPath) !== await this.sha256(target)) {
              throw new Error(`A different file already exists at the canonical destination:\n${target}`);
            }
          } else {
            await IOUtils.copy(oldPath, target, { noOverwrite: true });
            copied = true;
            const [srcStat, dstStat] = await Promise.all([IOUtils.stat(oldPath), IOUtils.stat(target)]);
            if (srcStat.size !== dstStat.size) throw new Error("Destination size verification failed.");
            if (await this.sha256(oldPath) !== await this.sha256(target)) throw new Error("Destination checksum verification failed.");
          }

          status.setText(`Relinking Zotero attachment\n${PathUtils.filename(target)}`);
          status.setProgress(55);
          await canonical.a.relinkAttachmentFile(target);
          relinked = true;
          const reloaded = await Zotero.Items.getAsync(canonical.a.id);
          try { await reloaded.reload(); } catch (e) {}
          let persisted = null;
          try { persisted = await reloaded.getFilePathAsync(); } catch (e) {}
          if (this.pathKey(persisted) !== targetKey) {
            throw new Error(`Zotero relink verification failed.\nExpected: ${target}\nResolved: ${persisted || "no path"}`);
          }
        }

        status.setText("Removing redundant linked-PDF records");
        status.setProgress(75);
        for (const extra of pdfs) {
          if (extra.a.id === canonical.a.id) continue;
          await extra.a.eraseTx();
          removed++;
          if (extra.key !== targetKey && await this.exists(extra.path)) {
            const refs = await this.linkedAttachmentMap();
            if (!(refs.get(extra.path.replace(/\\/g, "/")) || []).length) {
              await IOUtils.remove(extra.path);
              deleted++;
            }
          }
        }

        if (oldKey !== targetKey && await this.exists(oldPath)) {
          const refs = await this.linkedAttachmentMap();
          if (!(refs.get(oldPath.replace(/\\/g, "/")) || []).length) {
            await IOUtils.remove(oldPath);
            deleted++;
          }
        }

        await this.finishProgress(run, status, true);
        this.showReport(win, "StorScan — Normalize Selected Item", `Selected item normalized successfully.\nPersisted Zotero path verified: yes\nRelinked: ${relinked ? "yes" : "already canonical"}\nExtra attachment records removed: ${removed}\nOld files deleted: ${deleted}`, `Old path:\n${oldPath}\n\nNew path:\n${target}`);
      } catch (e) {
        if (copied && !relinked && await this.exists(target)) { try { await IOUtils.remove(target); } catch (_) {} }
        throw e;
      }
    } finally {
      this.running = false;
    }
  },

  async normalizeOutsideBase(win) {
    return this.normalizeLinkedFiles(win, { outsideOnly: true });
  },

  async normalizeLinkedFiles(win, options = {}) {
    if (this.running) throw new Error("StorScan is already running.");
    this.running = true;
    const base = await this.ensureBaseDirectory();
    let progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline(options.outsideOnly ? "StorScan — Fix Outside-Base PDFs" : "StorScan — Normalize PDFs");
    let line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", "Reading linked PDF attachments...");
    progress.show(); await this.enlargeProgressWindow(progress, 820, 230);

    try {
      const allAttachments = await this.getAttachments();
      const globalPathRefs = new Map();
      for (const a of allAttachments) {
        if (this.linkKind(a) !== "linked") continue;
        let path = null;
        try { path = await a.getFilePathAsync(); } catch (e) {}
        if (!path) continue;
        const key = this.pathKey(path);
        if (!globalPathRefs.has(key)) globalPathRefs.set(key, new Set());
        globalPathRefs.get(key).add(a.id);
      }

      const allItems = await Zotero.Items.getAsync(await this.searchIDs(false));
      const parents = (allItems || []).filter(item => item && item.isRegularItem && item.isRegularItem() && !item.deleted);
      const plans = [];

      for (let i = 0; i < parents.length; i++) {
        const parent = parents[i];
        line.setText(`Reading bibliographic item ${i + 1} of ${parents.length}`);
        line.setProgress(Math.round(((i + 1) / Math.max(1, parents.length)) * 30));
        let attachmentIDs = [];
        try { attachmentIDs = parent.getAttachments(false) || []; } catch (e) {}
        if (!attachmentIDs.length) continue;
        const children = await Zotero.Items.getAsync(attachmentIDs);
        const pdfs = [];
        for (const a of children || []) {
          if (!a || !(a.isAttachment && a.isAttachment()) || this.linkKind(a) !== "linked") continue;
          let path = null;
          try { path = await a.getFilePathAsync(); } catch (e) {}
          if (!(path && await this.exists(path))) continue;
          if (!(a.attachmentContentType === "application/pdf" || /\.pdf$/i.test(path))) continue;
          pdfs.push({ a, path, key: this.pathKey(path) });
        }
        if (!pdfs.length) continue;
        const targetDir = PathUtils.join(base, this.creator(parent));
        const target = PathUtils.join(targetDir, this.filename(parent));
        const targetKey = this.pathKey(target);
        const hasOutsideBase = pdfs.some(x => !this.isInsideBase(x.path, base));
        if (options.outsideOnly && !hasOutsideBase) continue;
        if (!(pdfs.length === 1 && pdfs[0].key === targetKey)) {
          plans.push({ parent, pdfs, targetDir, target, targetKey });
        }
        if (i && i % 50 === 0) await Zotero.Promise.delay(0);
      }

      if (!plans.length) {
        await this.finishProgressState(progress, line, "Completed\nNo changes were necessary.");
        return this.alert(win, "StorScan", options.outsideOnly ? "No working linked PDFs were found outside Zotero's Linked Attachment Base Directory." : "All working linked PDFs are already stored in the correct author folders under Zotero's Linked Attachment Base Directory and use the canonical filename format.");
      }

      const totalPDFs = plans.reduce((n, p) => n + p.pdfs.length, 0);
      try { progress.close(); } catch (e) {}
      progress = null; line = null;
      if (!this.confirm(win, options.outsideOnly ? "Fix Linked PDFs Outside Base Directory" : "Normalize Linked PDFs by Zotero Item", `StorScan found ${plans.length} bibliographic items containing ${totalPDFs} linked PDFs that need normalization.\n\nFor each item StorScan will:\n• keep exactly one linked PDF\n• place it in the configured Linked Attachment Base Directory\n• organize it in an author folder\n• rename it as LastName - Year - Short Title.pdf\n• remove extra linked-PDF records\n• delete an old source file only after the new link is verified and no Zotero record still references the old path\n\nBack up first. Continue?`)) return;

      progress = new Zotero.ProgressWindow({ closeOnClick: false });
      progress.changeHeadline("StorScan — Normalize PDFs");
      line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", `Preparing ${plans.length} bibliographic items...`);
      line.setProgress(0);
      progress.show(); await this.enlargeProgressWindow(progress, 820, 230);

      let moved = 0, renamed = 0, removedRecords = 0, deletedFiles = 0;
      let conflicts = 0, failed = 0;

      for (let index = 0; index < plans.length; index++) {
        const plan = plans[index];
        const title = plan.parent.getField("title") || `Item ${plan.parent.id}`;
        line.setText(`Normalizing ${index + 1} of ${plans.length}\n${title}`);
        line.setProgress(Math.round(((index + 1) / Math.max(1, plans.length)) * 100));
        await Zotero.Promise.delay(0);
        try {
          await IOUtils.makeDirectory(plan.targetDir, { createAncestors: true, ignoreExisting: true });
          let canonical = plan.pdfs.find(x => x.key === plan.targetKey)
            || plan.pdfs.find(x => this.isInsideBase(x.path, base))
            || plan.pdfs[0];
          const originalPath = canonical.path;
          const originalKey = canonical.key;

          if (originalKey !== plan.targetKey) {
            if (await this.exists(plan.target)) {
              const [srcStat, dstStat] = await Promise.all([IOUtils.stat(originalPath), IOUtils.stat(plan.target)]);
              const same = srcStat.size === dstStat.size && await this.sha256(originalPath) === await this.sha256(plan.target);
              if (!same) {
                conflicts++;
                Zotero.logError(new Error(`StorScan destination conflict for Zotero item ${plan.parent.id}: ${plan.target}`));
                continue;
              }
            } else {
              await IOUtils.copy(originalPath, plan.target, { noOverwrite: true });
              const [srcStat, dstStat] = await Promise.all([IOUtils.stat(originalPath), IOUtils.stat(plan.target)]);
              if (srcStat.size !== dstStat.size) throw new Error("Destination size verification failed");
              if (await this.sha256(originalPath) !== await this.sha256(plan.target)) throw new Error("Destination checksum verification failed");
            }

            await canonical.a.relinkAttachmentFile(plan.target);
            const reloadedAttachment = await Zotero.Items.getAsync(canonical.a.id);
            try { await reloadedAttachment.reload(); } catch (e) {}
            let verifiedPath = null;
            try { verifiedPath = await reloadedAttachment.getFilePathAsync(); } catch (e) {}
            if (this.pathKey(verifiedPath) !== plan.targetKey) {
              throw new Error(`Zotero link verification failed. Expected ${plan.target}, got ${verifiedPath || "no path"}`);
            }

            globalPathRefs.get(originalKey)?.delete(canonical.a.id);
            if (!globalPathRefs.has(plan.targetKey)) globalPathRefs.set(plan.targetKey, new Set());
            globalPathRefs.get(plan.targetKey).add(canonical.a.id);
            canonical = { a: canonical.a, path: plan.target, key: plan.targetKey };
            if (this.isInsideBase(originalPath, base)) renamed++; else moved++;
          }

          for (const extra of plan.pdfs) {
            if (extra.a.id === canonical.a.id) continue;
            await extra.a.eraseTx();
            removedRecords++;
            globalPathRefs.get(extra.key)?.delete(extra.a.id);
            if ((globalPathRefs.get(extra.key)?.size || 0) === 0
                && extra.key !== canonical.key
                && await this.exists(extra.path)) {
              await IOUtils.remove(extra.path);
              deletedFiles++;
            }
          }

          if (originalKey !== canonical.key
              && (globalPathRefs.get(originalKey)?.size || 0) === 0
              && await this.exists(originalPath)) {
            await IOUtils.remove(originalPath);
            deletedFiles++;
          }
        } catch (e) {
          failed++;
          Zotero.logError(e);
        }
        if ((index + 1) % 10 === 0) await Zotero.Promise.delay(0);
      }

      await this.finishProgress(progress, line, true);
      this.showReport(win, "StorScan — Normalize Linked PDFs", `Bibliographic items evaluated: ${plans.length}\nPDFs moved into base directory: ${moved}\nPDFs renamed or reorganized: ${renamed}\nExtra attachment records removed: ${removedRecords}\nOld files deleted: ${deletedFiles}\nConflicts: ${conflicts}\nFailures: ${failed}`, plans.map(p => `${p.parent.getField("title") || "Untitled"}\n  Source: ${(p.pdfs && p.pdfs[0] && p.pdfs[0].path) || "Unavailable"}\n  Target: ${p.target}`).join("\n\n"));
    } finally {
      this.running = false;
    }
  },
  async proposedZoteroFilename(attachment, parent) {
    const path = await attachment.getFilePathAsync();
    const ext = (PathUtils.filename(path).match(/(\.[^.]+)$/) || ["", ".pdf"])[1];
    return this.filename(parent, ext);
  },

  async renameCandidates() {
    const out = [];
    for (const a of await this.getAttachments()) {
      if (this.linkKind(a) !== "linked" || !a.parentItemID) continue;
      let path = null;
      try { path = await a.getFilePathAsync(); } catch (e) {}
      if (!(path && await this.exists(path))) continue;
      const parent = await Zotero.Items.getAsync(a.parentItemID);
      if (!parent?.isRegularItem?.()) continue;
      const proposed = await this.proposedZoteroFilename(a, parent);
      const current = PathUtils.filename(path);
      out.push({ a, parent, path, current, proposed });
    }
    return out;
  },

  async previewRenameLinkedAttachments(win) {
    if (this.running) throw new Error("StorScan is already running.");
    this.running = true;
    const progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("StorScan — Preview Rename");
    const line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", "Reading linked attachments and calculating filenames...");
    line.setProgress(0);
    progress.show(); await this.enlargeProgressWindow(progress, 860, 250, 1060, 680);
    try {
      const rows = await this.renameCandidates();
      line.setProgress(95);
      const changes = rows.filter(x => x.current !== x.proposed || (x.a.getField("title") || "") !== x.proposed.replace(/\.[^.]+$/, ""));
      const filenameChanges = changes.filter(x => x.current !== x.proposed).length;
      const titleOnlyChanges = changes.length - filenameChanges;
      const clip = (name, max = 52) => name.length <= max ? name : name.slice(0, max - 1) + "…";
      const sampleRows = changes.slice(0, 8).map(x => {
        if (x.current === x.proposed) return `• ${clip(x.current)}  [title only]`;
        return `• ${clip(x.current)}\n  → ${clip(x.proposed)}`;
      });
      const sample = sampleRows.join("\n");
      await this.finishProgress(progress, line, true);
      this.showReport(win, "StorScan — Preview Rename", `${changes.length} linked attachments need changes.\nFilenames: ${filenameChanges}\nAttachment titles only: ${titleOnlyChanges}\nNo files were changed.`, changes.map(x => `${x.current}\n  -> ${x.proposed}`).join("\n\n"));
    } finally { this.running = false; }
  },

  async renameLinkedAttachments(win) {
    if (this.running) throw new Error("StorScan is already running.");
    this.running = true;
    const progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("StorScan — Rename Linked Attachments");
    const line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", "Reading linked attachments...");
    progress.show(); await this.enlargeProgressWindow(progress);
    try {
      const rows = await this.renameCandidates();
      const changes = rows.filter(x => x.current !== x.proposed || (x.a.getField("title") || "") !== x.proposed.replace(/\.[^.]+$/, ""));
      if (!changes.length) { await this.finishProgressState(progress, line, "Completed\nNo changes were necessary."); return this.alert(win, "StorScan", "All working linked attachments already match Zotero's configured filename format and attachment-title convention."); }
      if (!this.confirm(win, "Rename All Attachments", `Rename ${changes.length} linked attachment files and set their Zotero attachment titles to the resulting filename without the extension?\n\nStorScan will prefer each item's Short Title. When Short Title is empty, it will use a concise word-boundary excerpt from the full Title. Continue?`)) return;
      let renamed = 0, skipped = 0, failed = 0;
      for (let i = 0; i < changes.length; i++) {
        const x = changes[i];
        line.setText(`Renaming ${i + 1} of ${changes.length}\n${x.parent.getField("title") || x.current}`);
        line.setProgress(Math.round((i + 1) / changes.length * 100));
        try {
          if (typeof x.a.renameAttachmentFile !== "function") throw new Error("This Zotero version does not expose renameAttachmentFile().");
          await x.a.renameAttachmentFile();
          const reloaded = await Zotero.Items.getAsync(x.a.id);
          try { await reloaded.reload(); } catch (e) {}
          const newPath = await reloaded.getFilePathAsync();
          if (!(newPath && await this.exists(newPath))) throw new Error("Renamed file could not be verified.");
          const newTitle = PathUtils.filename(newPath).replace(/\.[^.]+$/, "");
          reloaded.setField("title", newTitle);
          await reloaded.saveTx();
          renamed++;
        } catch (e) { failed++; Zotero.logError(e); }
        if (i && i % 20 === 0) await Zotero.Promise.delay(0);
      }
      await this.finishProgress(progress, line, true);
      this.showReport(win, "StorScan — Rename Linked Attachments", `Linked attachments considered: ${changes.length}\nRenamed and verified: ${renamed}\nSkipped: ${skipped}\nFailed: ${failed}`, changes.map(x => `${x.current} -> ${x.proposed}`).join("\n"));
    } finally { this.running = false; }
  },

  cleanName(s, fallback = "Untitled") {
    const v = Zotero.File.getValidFileName(String(s || fallback))
      .replace(/[\\/]/g, "-")
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return v || fallback;
  },
  creatorData(parent) {
    const cs = parent.getCreators();
    let authors = cs.filter(c => c.creatorType === "author");
    if (!authors.length) authors = cs.filter(c => c.creatorType === "editor");
    if (!authors.length) authors = cs;
    const firstCreator = this.cleanName(authors[0]?.lastName || authors[0]?.name || "No Author", "No Author");
    return {
      firstCreator,
      multipleAuthors: authors.length > 1 ? String(this.getPref("multipleAuthorsSuffix", " et al")) : ""
    };
  },
  year(parent) {
    const d = parent.getField("date") || "";
    return (d.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/) || ["n.d."])[0];
  },
  expandTemplate(template, parent) {
    const data = this.creatorData(parent);
    return String(template || "")
      .replaceAll("{{firstCreator}}", data.firstCreator)
      .replaceAll("{{multipleAuthors}}", data.multipleAuthors)
      .replaceAll("{{year}}", this.year(parent))
      .replaceAll("{{title}}", parent.getField("title") || "Untitled");
  },
  creator(parent) {
    const template = this.getPref("folderTemplate", "{{firstCreator}}{{multipleAuthors}}");
    return this.cleanName(this.expandTemplate(template, parent), "No Author");
  },
  preferredFilenameTitle(parent, availableLength = 55) {
    const shortTitle = String(parent.getField("shortTitle") || "").trim();
    let title = this.cleanName(shortTitle || parent.getField("title") || "Untitled");
    const limit = Math.max(18, Math.min(90, Number(availableLength) || 55));
    if (Array.from(title).length > limit) {
      title = Array.from(title).slice(0, limit).join("");
      const cut = Math.max(title.lastIndexOf(" "), title.lastIndexOf("-"), title.lastIndexOf(":"));
      if (cut >= Math.floor(limit * 0.62)) title = title.slice(0, cut);
      title = title.replace(/[ .,:;_-]+$/g, "");
    }
    return title || "Untitled";
  },
  filename(parent, extension = ".pdf") {
    const firstCreator = this.creatorData(parent).firstCreator;
    const year = this.year(parent) || "n.d.";
    const prefix = `${firstCreator} - ${year} - `;
    const maxBaseLength = Math.max(30, Math.min(200, Number(this.getPref("maxFilenameLength", 80)) || 80));
    const maxTitleLength = Math.max(18, maxBaseLength - Array.from(prefix).length);
    const title = this.preferredFilenameTitle(parent, maxTitleLength);
    const ext = String(extension || ".pdf").startsWith(".") ? String(extension || ".pdf") : `.${extension}`;
    return this.cleanName(prefix + title) + ext;
  },
  async uniqueDestination(base,parent,source){const dir=PathUtils.join(base,this.creator(parent));await IOUtils.makeDirectory(dir,{createAncestors:true,ignoreExisting:true});const wanted=PathUtils.join(dir,this.filename(parent));if(!(await this.exists(wanted)))return wanted;
    try{const [a,b]=await Promise.all([this.sha256(source),this.sha256(wanted)]);if(a===b)return wanted;}catch(e){}
    const stem=wanted.replace(/\.pdf$/i,"");for(let n=2;n<1000;n++){const p=`${stem} (${n}).pdf`;if(!(await this.exists(p)))return p;}throw new Error("Could not create a unique destination filename");},
  async convertStoredFiles(win) {
    if (this.running) throw new Error("StorScan is already running.");
    this.running = true;
    const base = await this.ensureBaseDirectory();
    const progress = new Zotero.ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("StorScan — Move Stored PDFs");
    const line = new progress.ItemProgress("chrome://zotero/skin/spinner-16px.png", "Finding stored PDFs...");
    progress.show(); await this.enlargeProgressWindow(progress);
    try {
      const stored = [];
      const attachments = await this.getAttachments();
      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        line.setText(`Checking attachment ${i + 1} of ${attachments.length}`);
        line.setProgress(Math.round(((i + 1) / Math.max(1, attachments.length)) * 25));
        if (this.linkKind(a) !== "stored" || a.attachmentContentType !== "application/pdf" || !a.parentItemID) continue;
        let p = null; try { p = await a.getFilePathAsync(); } catch (e) {}
        if (p && await this.exists(p)) stored.push({ a, p, parent: await Zotero.Items.getAsync(a.parentItemID) });
        if (i && i % 100 === 0) await Zotero.Promise.delay(0);
      }
      if (!stored.length) {
        await this.finishProgressState(progress, line, "Completed\nNo changes were necessary.");
        return this.alert(win, "StorScan", "No working stored child PDFs were found.");
      }
      if (!this.confirm(win, "Move Stored PDFs to Linked Base Directory", `Move ${stored.length} working stored PDFs into author folders under:
${base}

Each destination is verified before Zotero's stored attachment is removed. Existing identical base-directory files are reused. Continue?`)) {
        await this.finishProgressState(progress, line, "Operation cancelled."); return;
      }
      let converted = 0, reused = 0, failed = 0;
      for (let i = 0; i < stored.length; i++) {
        const x = stored[i]; let dest = null, newAtt = null, copied = false;
        line.setText(`Moving stored PDF ${i + 1} of ${stored.length}`);
        line.setProgress(25 + Math.round(((i + 1) / Math.max(1, stored.length)) * 75));
        try {
          dest = await this.uniqueDestination(base, x.parent, x.p);
          if (await this.exists(dest)) { reused++; }
          else { await IOUtils.copy(x.p, dest, { noOverwrite: true }); copied = true; const [s1, s2] = await Promise.all([IOUtils.stat(x.p), IOUtils.stat(dest)]); if (s1.size !== s2.size) throw new Error("Destination size verification failed"); }
          newAtt = await Zotero.Attachments.linkFromFile({ file: dest, libraryID: x.parent.libraryID, parentItemID: x.parent.id, saveOptions: { skipSelect: true } });
          const title = x.a.getField("title"); if (title) newAtt.setField("title", title); const note = x.a.getNote(); if (note) newAtt.setNote(note); newAtt.setTags(x.a.getTags()); newAtt.setRelations(x.a.getRelations()); await newAtt.saveTx();
          await Zotero.DB.executeTransaction(async () => { await Zotero.Items.moveChildItems(x.a, newAtt); });
          try { await Zotero.Relations.copyObjectSubjectRelations(x.a, newAtt); } catch (e) { Zotero.logError(e); }
          try { await Zotero.DB.executeTransaction(async () => { await Zotero.Fulltext.transferItemIndex(x.a, newAtt); }); } catch (e) { Zotero.logError(e); }
          await x.a.eraseTx(); converted++;
        } catch (e) {
          failed++; Zotero.logError(e); if (newAtt) { try { await newAtt.eraseTx(); } catch (_) {} }
          if (copied && dest && await this.exists(dest)) { try { await IOUtils.remove(dest); } catch (_) {} }
        }
        if (i && i % 10 === 0) await Zotero.Promise.delay(0);
      }
      await this.finishProgress(progress, line, true);
      this.showReport(win, "StorScan — Move Stored PDFs", `Stored PDFs converted: ${converted}
Existing identical files reused: ${reused}
Failed: ${failed}`, stored.map(x => `${x.parent.getField("title") || "Untitled"}
  Source: ${x.p}`).join("\n\n"));
    } finally { this.running = false; }
  }
};

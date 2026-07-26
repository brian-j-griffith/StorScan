var StorageScannerPlugin;
function install() {}
async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + "storage-scanner.js");
  StorageScannerPlugin.init({ id, version, rootURI });
  await StorageScannerPlugin.registerPreferences();
  StorageScannerPlugin.addToAllWindows();
}
function onMainWindowLoad({ window }) { StorageScannerPlugin?.addToWindow(window); }
function onMainWindowUnload({ window }) { StorageScannerPlugin?.removeFromWindow(window); }
function shutdown() { StorageScannerPlugin?.removeFromAllWindows(); StorageScannerPlugin = undefined; }
function uninstall() {}

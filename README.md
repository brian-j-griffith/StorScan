# StorScan

**Audit, organize, repair, rename, and manage linked attachments in Zotero.**

StorScan is an all-in-one attachment management toolkit for Zotero that helps researchers organize, repair, and maintain large libraries of linked attachments. It combines library auditing, attachment repair, author-folder organization, batch renaming, duplicate management, full-text acquisition, and detailed reporting into a single integrated plugin.

---

## Features

### 🔍 Scan & Fix

Audit your library and identify attachment problems before making changes.

- **Scan Library** — Performs a comprehensive health check of every attachment in your library.
- **Fix Misplaced Files** — Finds linked PDFs stored outside your configured Linked Attachment Base Directory and moves them into their canonical locations.
- **Preview Cleanup** — Shows exactly what StorScan would change before any files are modified.

---

### 📁 Organize & Repair

Repair and organize linked attachments while preserving bibliographic records.

- **Organize Selected Item** — Repairs and reorganizes attachments belonging to a single Zotero item.
- **Organize All Files** — Applies the same verified organization process across the entire library.
- **Convert Stored Files** — Converts Zotero-managed stored attachments into linked attachments inside your Linked Attachment Base Directory.
- **Remove Broken Links** — Removes attachment records whose files no longer exist.
- **Merge Duplicate Files** — Consolidates duplicate linked PDFs throughout the attachment directory.
- **Merge Item Attachments** — Removes duplicate PDF attachments attached to the same bibliographic item.

All file operations are verified before obsolete files or attachment records are removed.

---

### ✏️ Rename

Rename linked attachments using Zotero metadata.

- **Preview Renaming** — Displays proposed filename changes before any files are renamed.
- **Rename All Attachments** — Renames linked files using Zotero's filename template, preferring the **Short Title** field when available and falling back to a concise version of the full title when necessary.

Attachment titles within Zotero are updated to match the renamed files.

---

### 📚 Find Full Text

Locate and attach legally available full text to existing bibliographic records.

- **Find Open Full Text** — Searches supported open-access sources for available PDFs.
- **Attach Local File** — Imports an existing PDF or EPUB into the selected Zotero item while automatically organizing and renaming it.
- **Search Open Library** — Opens a search for publicly available bibliographic records.
- **Full-Text Settings** — Configures full-text lookup options.

Any imported attachment automatically passes through StorScan's organization and renaming pipeline.

---

### 🛠 Utilities

Additional tools simplify maintenance and troubleshooting.

- **Inspect Selected Item** — Displays detailed diagnostic information for the selected bibliographic item or any of its child attachments, including linked paths, canonical destinations, and normalization status.
- **Open Base Directory** — Opens your configured Linked Attachment Base Directory in your operating system's file manager.

---

## Author Folder Organization

StorScan automatically organizes linked attachments into author-based folders using customizable templates.

Folder names, filename length, author formatting, and multiple-author behavior can all be customized through StorScan's Preferences.

---

## Reporting

Every major operation generates a detailed report including:

- Files processed
- Files moved
- Files renamed
- Duplicate files merged
- Skipped items
- Errors encountered
- Verification results

Reports automatically resize up to the available screen space, become scrollable for large jobs, and can be copied or exported as UTF-8 text files for documentation or troubleshooting.

---

## Designed for Large Libraries

StorScan is designed for researchers managing extensive Zotero libraries with linked attachments.

Whether you're migrating an existing collection, reorganizing thousands of PDFs, repairing broken links, or maintaining a consistent attachment structure, StorScan provides a unified workflow for keeping your library clean, organized, and reliable.

---

## Requirements

- Zotero 9
- Linked Attachment Base Directory configured (recommended)

---

## Credits

**Vibe Coded with ChatGPT EDU by Brian J. Griffith with code by Emiliano Heyns.**

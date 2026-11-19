'use strict';

const { Menu, MenuItem, shell, clipboard } = require('electron');

/**
 * Electron ships with no right-click menu at all, so cut/copy/paste and spelling corrections never appear.
 * This builds the usual one: spelling suggestions first, then edit actions, then link actions.
 */
function attachContextMenu(webContents) {
  webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();
    const { isEditable, selectionText, editFlags, misspelledWord, dictionarySuggestions, linkURL } = params;
    const hasSelection = Boolean(selectionText && selectionText.trim());

    if (isEditable && misspelledWord) {
      for (const suggestion of dictionarySuggestions.slice(0, 5)) {
        menu.append(new MenuItem({ label: suggestion, click: () => webContents.replaceMisspelling(suggestion) }));
      }
      if (!dictionarySuggestions.length) menu.append(new MenuItem({ label: 'No suggestions', enabled: false }));
      menu.append(new MenuItem({
        label: `Add “${misspelledWord}” to dictionary`,
        click: () => webContents.session.addWordToSpellCheckerDictionary(misspelledWord),
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (isEditable) {
      menu.append(new MenuItem({ label: 'Undo', role: 'undo', enabled: editFlags.canUndo }));
      menu.append(new MenuItem({ label: 'Redo', role: 'redo', enabled: editFlags.canRedo }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Cut', role: 'cut', enabled: editFlags.canCut }));
      menu.append(new MenuItem({ label: 'Copy', role: 'copy', enabled: editFlags.canCopy }));
      menu.append(new MenuItem({ label: 'Paste', role: 'paste', enabled: editFlags.canPaste }));
      menu.append(new MenuItem({ label: 'Select all', role: 'selectAll', enabled: editFlags.canSelectAll }));
    } else if (hasSelection) {
      menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
    }

    if (linkURL && /^https?:/i.test(linkURL)) {
      if (menu.items.length) menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Open link in browser', click: () => shell.openExternal(linkURL) }));
      menu.append(new MenuItem({ label: 'Copy link address', click: () => clipboard.writeText(linkURL) }));
    }

    if (menu.items.length) menu.popup();
  });
}

module.exports = { attachContextMenu };

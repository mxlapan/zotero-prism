/**
 * Icon URLs.
 *
 * Zotero ships two icon sets and picks one by slot: 16px for menu rows and
 * item-pane section headers, 20px for the item-pane sidenav. Handing a 16px
 * file to the sidenav paints it at 16px inside a 20px box, which reads as an
 * undersized icon sitting next to Zotero's own.
 */

import { config } from "../../package.json";

function url(size: 16 | 20, name: string) {
  return `chrome://${config.addonRef}/content/icons/${size}/${name}.svg`;
}

/** Menu rows and item-pane section headers. */
export function icon16(name = "favicon") {
  return url(16, name);
}

/** The item-pane sidenav. */
export function icon20(name = "favicon") {
  return url(20, name);
}

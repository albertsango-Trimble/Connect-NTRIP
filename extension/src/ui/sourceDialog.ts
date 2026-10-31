import type { ProjectFiles, ProjectItem } from '../connect/projectFiles';

export interface SourceOptions {
  title: string;
  /** Value for the file picker's accept attribute */
  accept: string;
  multiple: boolean;
  /** Whether a project file name is one this button can use */
  suits: (name: string) => boolean;
  /** Null when the page isn't running inside Trimble Connect */
  project: ProjectFiles | null;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const formatSize = (bytes?: number) =>
  bytes === undefined ? '' : bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

/** Either files from this computer, or files in the project that the caller downloads as it needs them. */
export type SourceChoice = { files: File[] } | { project: ProjectItem[]; /** Where in the project the files are, e.g. "Project / Raw Data" */ folders: string[] };

/**
 * Asks where files should come from: this computer, or the Trimble Connect project.
 * Resolves with the chosen files, or null if the person cancelled.
 */
export function chooseSource(options: SourceOptions): Promise<SourceChoice | null> {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'source-dialog');
    const body = el('div', 'source-body');
    dialog.appendChild(body);
    document.body.appendChild(dialog);

    let settled = false;
    const finish = (choice: SourceChoice | null) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(choice);
    };
    dialog.addEventListener('cancel', () => finish(null));
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) finish(null);
    });

    const header = (title: string) => {
      const row = el('div', 'source-header');
      row.append(el('h2', undefined, title));
      const close = el('button', 'source-close', '×');
      close.type = 'button';
      close.title = 'Cancel';
      close.addEventListener('click', () => finish(null));
      row.append(close);
      return row;
    };

    const showChoices = () => {
      body.replaceChildren(header(options.title));
      const list = el('div', 'source-choices');

      const pc = el('button', 'source-choice');
      pc.type = 'button';
      pc.append(el('strong', undefined, 'Upload from PC'), el('span', undefined, 'Choose files on this computer'));
      pc.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = options.accept;
        input.multiple = options.multiple;
        input.addEventListener('change', () => finish({ files: Array.from(input.files ?? []) }));
        input.addEventListener('cancel', () => finish(null));
        input.click();
      });

      const proj = el('button', 'source-choice');
      proj.type = 'button';
      proj.append(
        el('strong', undefined, 'Load from project'),
        el('span', undefined, options.project ? 'Choose files already in this Trimble Connect project' : 'Only available inside Trimble Connect'),
      );
      proj.disabled = !options.project;
      proj.addEventListener('click', () => void showProject());

      list.append(proj, pc);
      body.append(list);
    };

    const showProject = async () => {
      const project = options.project;
      if (!project) return;
      const trail: { id: string; name: string }[] = [];
      const chosen = new Map<string, ProjectItem>();
      const folderOf = new Map<string, string>();

      const status = el('div', 'source-status');
      const render = async (folder: { id: string; name: string } | null) => {
        body.replaceChildren(header('Load from project'));
        const crumbs = el('div', 'source-crumbs');
        body.append(crumbs, status);
        status.className = 'source-status';
        status.textContent = 'Loading…';
        try {
          if (!folder) {
            folder = await project.root();
            trail.splice(0, trail.length, folder);
          }
          const items = await project.list(folder.id);
          const current = folder;

          trail.forEach((step, i) => {
            const crumb = el('button', 'source-crumb', step.name);
            crumb.type = 'button';
            crumb.addEventListener('click', () => {
              trail.splice(i + 1);
              void render(step);
            });
            crumbs.append(crumb);
            if (i < trail.length - 1) crumbs.append(el('span', undefined, '›'));
          });

          const rows = el('div', 'source-rows');
          const shown = items.filter((i) => i.isFolder || options.suits(i.name));
          for (const item of shown) {
            const row = el('label', 'source-row');
            if (item.isFolder) {
              row.className = 'source-row folder';
              row.append(el('span', 'source-icon', '📁'), el('span', 'source-name', item.name));
              row.addEventListener('click', (e) => {
                e.preventDefault();
                trail.push({ id: item.id, name: item.name });
                void render({ id: item.id, name: item.name });
              });
            } else {
              const box = document.createElement('input');
              box.type = 'checkbox';
              box.checked = chosen.has(item.id);
              box.addEventListener('change', () => {
                if (box.checked) {
                  chosen.set(item.id, item);
                  folderOf.set(item.id, trail.map((t) => t.name).join(' / '));
                }
                else chosen.delete(item.id);
                update();
              });
              row.append(box, el('span', 'source-name', item.name), el('span', 'source-size', formatSize(item.size)));
            }
            rows.append(row);
          }
          if (shown.length === 0) rows.append(el('div', 'source-empty', 'Nothing here that this button can use.'));
          status.textContent = '';
          body.insertBefore(rows, status);

          const actions = el('div', 'source-actions');
          const back = el('button', 'btn', 'Back');
          back.type = 'button';
          back.addEventListener('click', showChoices);
          const all = el('button', 'btn', 'Select all in folder');
          all.type = 'button';
          all.addEventListener('click', () => {
            shown.filter((i) => !i.isFolder).forEach((i) => {
              chosen.set(i.id, i);
              folderOf.set(i.id, trail.map((t) => t.name).join(' / '));
            });
            void render(current);
          });
          all.hidden = !options.multiple;
          const load = el('button', 'btn primary', 'Load');
          load.type = 'button';
          const update = () => {
            load.textContent = chosen.size > 0 ? `Load ${chosen.size} file${chosen.size === 1 ? '' : 's'}` : 'Load';
            load.disabled = chosen.size === 0;
          };
          update();
          load.addEventListener('click', () => finish({ project: [...chosen.values()], folders: [...new Set([...chosen.keys()].map((id) => folderOf.get(id) ?? ''))].filter(Boolean) }));
          actions.append(back, all, load);
          body.append(actions);
        } catch (err) {
          status.className = 'source-status err';
          status.textContent = err instanceof Error ? err.message : String(err);
          const back = el('button', 'btn', 'Back');
          back.type = 'button';
          back.addEventListener('click', showChoices);
          body.append(back);
        }
      };
      await render(null);
    };

    showChoices();
    dialog.showModal();
  });
}

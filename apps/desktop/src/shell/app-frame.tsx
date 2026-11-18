import { Box, Tooltip, ActionIcon } from '@mantine/core';
import { IconLayoutSidebar } from '@tabler/icons-react';
import { useRouterState } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { FrameSlotsContext, type FrameSlots } from './frame-slots';
import { usePanelHidden } from './panel-hidden';
import { Rail } from './rail';
import { railSectionForPath, type RailSection } from './rail-items';
import { useSidebarLabels } from './sidebar-labels';
import { shellLayout, ShellBand, SidebarSheet } from './shell-layout';
import { UnsavedGuardProvider } from './unsaved-guard';
import { useShellBand } from './use-shell-band';
import classes from './app-frame.module.css';

const RAIL_LABELLED_WIDTH = 200;
const RAIL_ICONS_WIDTH = 76;
const PANEL_WIDTH = 260;
/** The hairline that ends a sidebar column, in addition to its width. */
const HAIRLINE = 1;
const TITLE_ROW_HEIGHT = 44;
/** How long the pointer rests on the toggle before its tip shows. */
const TOGGLE_TIP_DELAY = 300;
/** Where a title lines up with the content's padding. */
const CONTENT_PADDING = 24;
/** Where the title starts when the traffic lights and the sidebar toggle sit on the content's own tone. */
const TITLE_START_BESIDE_LIGHTS = 116;

/** An open menu or list of options takes Esc first, so the sheet around it stays open. */
const aMenuIsOpen = (): boolean =>
  document.querySelector('[aria-haspopup][aria-expanded="true"]') !== null;

/**
 * The window's frame: two columns. The sidebar (a rail, and the section's panel where it has one) is one
 * tone from the window's top to its bottom and carries the traffic lights; the content column beside it
 * has its own tone and its own title row at the top. Views draw into the title row and the panel through
 * `TitleRow` and `Panel`. The window never scrolls: the content column is exactly as tall as the window and
 * its content scrolls inside it.
 */
export function AppFrame({
  banner,
  children,
}: {
  /** What sits at the top of the content, above the view. */
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}) {
  const band = useShellBand();
  const location = useRouterState({ select: (state) => state.location.href });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const section = railSectionForPath(pathname);
  const { hidden: panelHidden, toggle: togglePanelHidden } = usePanelHidden(section);
  const { labels: labelsPreferred, toggle: toggleLabels } = useSidebarLabels();

  const [titleHost, setTitleHost] = useState<HTMLElement | null>(null);
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);
  const [drawerHost, setDrawerHost] = useState<HTMLElement | null>(null);
  const [panelSection, setPanelSection] = useState<RailSection | null>(null);
  const [scrolled, setScrolled] = useState(false);
  // The toggle's tip is held by hand: it opens after a hover delay, and a click (or leaving) closes it,
  // which Mantine's own hover tip does not do on a click.
  const [toggleTip, setToggleTip] = useState(false);
  const toggleTipTimer = useRef<number | undefined>(undefined);
  const showToggleTip = (): void => {
    window.clearTimeout(toggleTipTimer.current);
    toggleTipTimer.current = window.setTimeout(() => {
      setToggleTip(true);
    }, TOGGLE_TIP_DELAY);
  };
  const hideToggleTip = (): void => {
    window.clearTimeout(toggleTipTimer.current);
    setToggleTip(false);
  };
  useEffect(
    () => () => {
      window.clearTimeout(toggleTipTimer.current);
    },
    [],
  );
  // What was opened over the content and where: moving anywhere (a row picked, a section opened) closes it.
  const [opened, setOpened] = useState<{ at: string; kind: SidebarSheet } | null>(null);
  // A sheet belongs to the page it was opened on and to the sheet bands: moving on, or growing to a window
  // that has no sheets, drops it for good rather than leaving it to come back on the way back.
  if (opened !== null && (opened.at !== location || band === ShellBand.Wide)) setOpened(null);
  const hasPanel = panelSection !== null && panelSection === section;
  // The panel's sheet has nothing to show once its section has no panel (it left while the sheet was open).
  const sheet =
    opened === null || (opened.kind === SidebarSheet.Panel && !hasPanel) ? null : opened.kind;
  const layout = shellLayout({
    band,
    hasPanel,
    panelHidden,
    labels: labelsPreferred,
    sheet,
  });

  const registerPanel = useCallback((registered: RailSection) => {
    setPanelSection(registered);
    return () => {
      setPanelSection((now) => (now === registered ? null : now));
    };
  }, []);

  /** ⇧⌘S: the rail's labels on a wide window; the whole sidebar over the content otherwise. */
  const toggleSidebar = (): void => {
    if (band === ShellBand.Wide) toggleLabels();
    else {
      setOpened(
        sheet === SidebarSheet.Sections ? null : { at: location, kind: SidebarSheet.Sections },
      );
    }
  };
  /** ⌘\ and a click on the open section's row: the panel, a column when wide and a sheet otherwise. */
  const togglePanel = (): void => {
    if (!hasPanel) return;
    if (band === ShellBand.Wide) togglePanelHidden();
    else setOpened(sheet === null ? { at: location, kind: SidebarSheet.Panel } : null);
  };
  const hidePanel = band === ShellBand.Wide && layout.panel === 'column' ? togglePanelHidden : null;

  const slots = useMemo<FrameSlots>(
    () => ({ titleHost, panelHost, drawerHost, hidePanel, registerPanel }),
    [titleHost, panelHost, drawerHost, hidePanel, registerPanel],
  );

  const mainRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  // The page's own scroll position says whether its title carries the hairline: a page that opens at the top
  // has none, whatever the last page's scroll was.
  useEffect(() => {
    setScrolled((mainRef.current?.scrollTop ?? 0) > 0);
  }, [location]);

  // A sheet takes focus when it opens, on the section that is open, and gives it back when it closes, so a
  // keyboard builder is neither left behind the sheet nor dropped on the page.
  const sheetOpen = layout.rail === 'sheet' || layout.panel === 'sheet';
  const sheetOpener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!sheetOpen) return undefined;
    const opener = document.activeElement;
    sheetOpener.current = opener instanceof HTMLElement ? opener : null;
    const toggle = toggleRef.current;
    const inSheet = layout.rail === 'sheet' ? railRef.current : panelHost;
    const target =
      inSheet?.querySelector<HTMLElement>('[aria-current="page"]') ??
      inSheet?.querySelector<HTMLElement>('a[href], button:not([disabled])');
    target?.focus();
    return () => {
      const back = sheetOpener.current?.isConnected === true ? sheetOpener.current : toggle;
      back?.focus();
    };
    // Only the sheet opening or closing moves focus, not a change of which parts it holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.altKey) {
        if (event.key === 'Escape' && sheet !== null && !aMenuIsOpen()) {
          // Taken: a view behind the sheet (a running turn's Esc) must not act on the key that closed it.
          event.preventDefault();
          setOpened(null);
        }
        return;
      }
      if (event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        toggleSidebar();
      } else if (!event.shiftKey && event.key === '\\') {
        if (!hasPanel) return;
        event.preventDefault();
        togglePanel();
      }
    };
    // Capture, because a tooltip stops Esc from bubbling while it shows: a tooltip over the toggle would
    // otherwise take the first Esc for itself and leave the sheet open.
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  });

  const railWidth = (layout.labels ? RAIL_LABELLED_WIDTH : RAIL_ICONS_WIDTH) + HAIRLINE;
  const columnWidth =
    layout.column === 'labelled'
      ? RAIL_LABELLED_WIDTH + HAIRLINE
      : layout.column === 'icons'
        ? RAIL_ICONS_WIDTH + HAIRLINE
        : 0;
  const panelColumn = layout.panel === 'column' ? PANEL_WIDTH + HAIRLINE : 0;
  const narrow = band === ShellBand.Narrow;
  // The toggle sits beside the lights where the sidebar is labelled or folded away, and under them in the
  // icons-only rail, which has no room beside them.
  const toggleBeside = layout.rail === 'hidden' || layout.labels;

  const railStyle: CSSProperties =
    layout.rail === 'column'
      ? {}
      : layout.rail === 'sheet'
        ? { width: railWidth }
        : { display: 'none' };
  const panelStyle: CSSProperties =
    layout.panel === 'column'
      ? {}
      : layout.panel === 'sheet'
        ? { width: PANEL_WIDTH + HAIRLINE, left: layout.rail === 'hidden' ? 0 : railWidth }
        : { display: 'none' };

  return (
    <FrameSlotsContext value={slots}>
      <UnsavedGuardProvider>
        <Box
          className={classes['root']}
          style={{
            gridTemplateColumns: `${String(columnWidth)}px ${String(panelColumn)}px minmax(0, 1fr)`,
            gridTemplateRows: `${String(TITLE_ROW_HEIGHT)}px minmax(0, 1fr)`,
          }}
        >
          <div
            className={classes['rail']}
            data-sheet={
              layout.rail === 'sheet' ? (layout.panel === 'sheet' ? 'joined' : '') : undefined
            }
            ref={railRef}
            style={railStyle}
            inert={layout.rail === 'hidden'}
          >
            <div className={classes['railDrag']} data-tauri-drag-region />
            <div className={classes['railBody']}>
              <Rail
                labels={layout.labels}
                onActiveClick={hasPanel && layout.panel !== 'none' ? togglePanel : null}
              />
            </div>
          </div>
          <div
            ref={setPanelHost}
            className={classes['panel']}
            data-sheet={layout.panel === 'sheet' ? '' : undefined}
            style={panelStyle}
            inert={layout.panel === 'hidden'}
            data-panel={layout.panel}
          />
          <Tooltip label="Toggle sidebar ⇧⌘S" position="bottom" opened={toggleTip}>
            <ActionIcon
              className={classes['toggle']}
              style={toggleBeside ? { left: 80, top: 8 } : { left: 24, top: 48 }}
              variant="subtle"
              color="gray"
              size={28}
              aria-label="Toggle sidebar"
              // A wide window's toggle flips labels and discloses nothing; otherwise it opens the sidebar sheet.
              ref={toggleRef}
              aria-pressed={band === ShellBand.Wide ? !layout.labels : undefined}
              aria-expanded={band === ShellBand.Wide ? undefined : sheet === SidebarSheet.Sections}
              onMouseEnter={showToggleTip}
              onMouseLeave={hideToggleTip}
              onClick={() => {
                hideToggleTip();
                toggleSidebar();
              }}
            >
              <IconLayoutSidebar size={16} stroke={1.6} />
            </ActionIcon>
          </Tooltip>
          <div
            ref={setTitleHost}
            className={classes['titleRow']}
            style={{ paddingLeft: narrow ? TITLE_START_BESIDE_LIGHTS : CONTENT_PADDING }}
            data-title-row=""
            data-scrolled={scrolled ? '' : undefined}
            data-tauri-drag-region
            inert={sheetOpen}
          />
          <div className={classes['content']} inert={sheetOpen}>
            {banner}
            <main
              ref={mainRef}
              className={classes['main']}
              onScroll={(event) => {
                setScrolled(event.currentTarget.scrollTop > 0);
              }}
            >
              {children}
            </main>
            <div ref={setDrawerHost} className={classes['drawerLayer']} />
          </div>
          {sheetOpen ? (
            <div
              className={classes['backdrop']}
              data-frame-backdrop
              // Where only the panel is a sheet the icons rail beside it stays clear, and clickable.
              style={{ left: layout.rail === 'column' ? columnWidth : 0 }}
              onClick={() => {
                setOpened(null);
              }}
              aria-hidden="true"
            />
          ) : null}
        </Box>
      </UnsavedGuardProvider>
    </FrameSlotsContext>
  );
}

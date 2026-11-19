import { Box, Splitter, Tooltip, ActionIcon } from '@mantine/core';
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
import { px, usePanelWidth } from './panel-width';
import { Rail } from './rail';
import { railSectionForPath, type RailSection } from './rail-items';
import { useSidebarLabels } from './sidebar-labels';
import {
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH,
  shellLayout,
  ShellBand,
  SidebarSheet,
} from './shell-layout';
import { UnsavedGuardProvider } from './unsaved-guard';
import { useShellBand } from './use-shell-band';
import classes from './app-frame.module.css';

const RAIL_LABELLED_WIDTH = 200;
const RAIL_ICONS_WIDTH = 60;
/** The hairline that ends a sidebar column, in addition to its width. */
const HAIRLINE = 1;
/** How long the pointer rests on the toggle before its tip shows. */
const TOGGLE_TIP_DELAY = 300;
/** Where a title lines up with the content's padding. */
const CONTENT_PADDING = 24;
/** Where a panel's head starts in its column. */
const PANEL_HEAD_PADDING = 16;
/** The sidebar button's place in the bar, right of the traffic lights. It never moves. */
const TOGGLE_LEFT = 88;
const TOGGLE_TOP = 8;
/** Where the bar's text may start: clear of the traffic lights and the sidebar button. */
const BAR_START = 128;

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
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const section = railSectionForPath(pathname);
  const { labels: labelsPreferred, toggle: toggleLabels } = useSidebarLabels();
  const { width: panelWidth, setWidth: setPanelWidth } = usePanelWidth();

  const [titleHost, setTitleHost] = useState<HTMLElement | null>(null);
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);
  const [drawerHost, setDrawerHost] = useState<HTMLElement | null>(null);
  const [panelSection, setPanelSection] = useState<RailSection | null>(null);
  // The toggle's tip is held by hand: it opens after a hover delay, and a click (or leaving) closes it,
  // which Mantine's own hover tip does not do on a click.
  const [toggleTipShown, setToggleTip] = useState(false);
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
  // A sheet belongs to the page (path) it was opened on and to the sheet bands: moving on, or growing to a window
  // that has no sheets, drops it for good rather than leaving it to come back on the way back.
  if (opened !== null && (opened.at !== pathname || band === ShellBand.Wide)) setOpened(null);
  const hasPanel = panelSection !== null && panelSection === section;
  // The panel's sheet has nothing to show once its section has no panel (it left while the sheet was open).
  const sheet =
    opened === null || (opened.kind === SidebarSheet.Panel && !hasPanel) ? null : opened.kind;
  const layout = shellLayout({
    band,
    hasPanel,
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
        sheet === SidebarSheet.Sections ? null : { at: pathname, kind: SidebarSheet.Sections },
      );
    }
  };
  /** ⌘\: the panel's sheet where the window is too narrow for its column. A wide window always shows it. */
  const togglePanel = (): void => {
    if (!hasPanel || band === ShellBand.Wide) return;
    setOpened(sheet === null ? { at: pathname, kind: SidebarSheet.Panel } : null);
  };
  const closeSheet = useCallback(() => {
    setOpened(null);
  }, []);
  const panelOpen = layout.panel === 'column' || layout.panel === 'sheet';
  const showPanel = useCallback(() => {
    if (!hasPanel || panelOpen) return;
    setOpened({ at: pathname, kind: SidebarSheet.Panel });
  }, [hasPanel, panelOpen, pathname]);

  const slots = useMemo<FrameSlots>(
    () => ({
      titleHost,
      panelHost,
      drawerHost,
      panelShown: layout.panel === 'column' || layout.panel === 'sheet',
      showPanel,
      closeSheet,
      registerPanel,
    }),
    [titleHost, panelHost, drawerHost, layout.panel, showPanel, closeSheet, registerPanel],
  );

  const toggleRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
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
        if (!hasPanel || band === ShellBand.Wide) return;
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
  const panelColumn = layout.panel === 'column';
  const wide = band === ShellBand.Wide;
  // The sidebar button does what ⇧⌘S does: on a wide window it narrows the rail to icons or widens it to labels,
  // otherwise it opens the sidebar over the content.
  const toggleTip = wide
    ? layout.labels
      ? 'Icons only ⇧⌘S'
      : 'Show labels ⇧⌘S'
    : 'Show the sidebar ⇧⌘S';
  const panelSheetLeft = layout.rail === 'hidden' ? 0 : railWidth;
  // What starts the bar right of the rail clears the lights and the button where the rail is narrower than them.
  const panelHeadStart = Math.max(
    PANEL_HEAD_PADDING,
    BAR_START - (panelColumn ? columnWidth : panelSheetLeft),
  );
  const titleStart = Math.max(
    CONTENT_PADDING,
    BAR_START - columnWidth - (panelColumn ? panelWidth + HAIRLINE : 0),
  );

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
        ? { width: panelWidth + HAIRLINE, left: panelSheetLeft }
        : { display: 'none' };
  const panelHostStyle = {
    ...panelStyle,
    '--shell-bar-start': `${String(panelHeadStart)}px`,
  } as CSSProperties;

  return (
    <FrameSlotsContext value={slots}>
      <UnsavedGuardProvider>
        <Box
          className={classes['root']}
          style={{
            gridTemplateColumns: `${String(columnWidth)}px minmax(0, 1fr)`,
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
              <Rail labels={layout.labels} />
            </div>
          </div>
          <Tooltip label={toggleTip} position="bottom" opened={toggleTipShown}>
            <ActionIcon
              className={classes['toggle']}
              style={{ left: TOGGLE_LEFT, top: TOGGLE_TOP }}
              variant="subtle"
              color="gray"
              size={28}
              aria-label="Toggle sidebar"
              ref={toggleRef}
              // A wide window's button flips labels and discloses nothing; otherwise it opens the sidebar sheet.
              aria-pressed={wide ? !layout.labels : undefined}
              aria-expanded={wide ? undefined : sheet === SidebarSheet.Sections}
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
          {/* The panel column and the content, with the panel's hairline as the handle that resizes it. */}
          <Splitter
            className={classes['split']}
            classNames={{ handle: classes['handle'] }}
            withHandle={false}
            lineSize={HAIRLINE}
            sizes={[px(panelWidth), 100]}
            onSizeChange={([panelSize]) => {
              if (panelSize !== undefined) setPanelWidth(parseFloat(String(panelSize)));
            }}
            mod={{ 'panel-column': panelColumn }}
          >
            {/* Only a panel column takes the pane's room: a sheet stands over the frame, and a hidden or absent
                panel takes none. */}
            <Splitter.Pane
              defaultSize={px(PANEL_WIDTH)}
              min={px(PANEL_MIN_WIDTH)}
              max={px(PANEL_MAX_WIDTH)}
              className={classes['panelPane']}
              style={panelColumn ? undefined : { display: 'contents' }}
            >
              <div
                ref={setPanelHost}
                className={classes['panel']}
                data-sheet={layout.panel === 'sheet' ? '' : undefined}
                style={panelHostStyle}
                inert={layout.panel === 'hidden'}
                data-panel={layout.panel}
              />
            </Splitter.Pane>
            <Splitter.Pane defaultSize={100} className={classes['workspace']}>
              <div
                ref={setTitleHost}
                className={classes['titleRow']}
                style={{ paddingLeft: titleStart }}
                data-title-row=""
                data-tauri-drag-region
                inert={sheetOpen}
              />
              <div className={classes['content']} inert={sheetOpen}>
                {banner}
                <main className={classes['main']}>{children}</main>
                <div ref={setDrawerHost} className={classes['drawerLayer']} />
              </div>
            </Splitter.Pane>
          </Splitter>
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

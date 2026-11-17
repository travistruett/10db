import { Box, Tooltip, ActionIcon } from '@mantine/core';
import { IconLayoutSidebar } from '@tabler/icons-react';
import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { FrameSlotsContext, type FrameSlots } from './frame-slots';
import { usePanelHidden } from './panel-hidden';
import { Rail } from './rail';
import { railSectionForPath, type RailSection } from './rail-items';
import { shellLayout, ShellBand } from './shell-layout';
import { useShellBand } from './use-shell-band';
import classes from './app-frame.module.css';

const RAIL_WIDTH = 52;
const PANEL_WIDTH = 260;
const TITLE_ROW_HEIGHT = 44;
/** Where the title row's text starts when the traffic lights and the sidebar button sit before it. */
const TITLE_START_CLEAR_OF_BUTTON = 112;
/** The surface's inner left edge, which a title lines up with. */
const SURFACE_PADDING = 24;

/**
 * The window's frame, in place of a header and a sidebar: a rail, an optional panel, a title row beside
 * the traffic lights, and one rounded surface that holds the view. Views draw into the title row and the
 * panel through `TitleRow` and `Panel`. The window never scrolls: the surface is exactly as tall as the
 * window and its content scrolls inside it.
 */
export function AppFrame({
  banner,
  children,
}: {
  /** What sits at the top of the surface, above the view. */
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}) {
  const band = useShellBand();
  const location = useRouterState({ select: (state) => state.location.href });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const section = railSectionForPath(pathname);
  const { hidden: panelHidden, toggle: togglePanelHidden } = usePanelHidden(section);

  const [titleHost, setTitleHost] = useState<HTMLElement | null>(null);
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);
  const [drawerHost, setDrawerHost] = useState<HTMLElement | null>(null);
  const [panelSection, setPanelSection] = useState<RailSection | null>(null);
  // The location the overlay was opened at: moving anywhere (a row picked, a section opened) closes it.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const overlayOpen = openedAt === location;

  const hasPanel = panelSection !== null && panelSection === section;
  const layout = shellLayout({ band, hasPanel, panelHidden, overlayOpen });

  const slots: FrameSlots = {
    titleHost,
    panelHost,
    drawerHost,
    registerPanel: (registered) => {
      setPanelSection(registered);
      return () => {
        setPanelSection((now) => (now === registered ? null : now));
      };
    },
  };

  const toggleSidebar = (): void => {
    if (band === ShellBand.Wide) togglePanelHidden();
    else setOpenedAt(overlayOpen ? null : location);
  };
  // A medium window with no panel has nothing for the button to open.
  const buttonShown = band === ShellBand.Wide ? hasPanel : band === ShellBand.Narrow || hasPanel;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey && !event.shiftKey && !event.altKey && event.key === '\\') {
        if (!buttonShown) return;
        event.preventDefault();
        toggleSidebar();
      } else if (event.key === 'Escape' && overlayOpen) {
        setOpenedAt(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  });

  const railColumn = layout.rail === 'shown' ? RAIL_WIDTH : 0;
  const panelColumn = layout.panel === 'column' ? PANEL_WIDTH : 0;
  const narrow = band === ShellBand.Narrow;
  const titleStart =
    layout.rail !== 'shown'
      ? TITLE_START_CLEAR_OF_BUTTON
      : buttonShown && layout.panel !== 'column'
        ? TITLE_START_CLEAR_OF_BUTTON - RAIL_WIDTH
        : SURFACE_PADDING;

  const label = overlayOpen || (band === ShellBand.Wide && !panelHidden) ? 'Hide' : 'Show';
  const noun = band === ShellBand.Narrow && !hasPanel ? 'the sections' : 'the panel';

  const railStyle: CSSProperties =
    layout.rail === 'shown'
      ? {}
      : layout.rail === 'overlay'
        ? {
            position: 'absolute',
            top: TITLE_ROW_HEIGHT,
            bottom: 8,
            left: 0,
            width: RAIL_WIDTH,
            zIndex: 20,
          }
        : { display: 'none' };
  const panelStyle: CSSProperties =
    layout.panel === 'column'
      ? {}
      : layout.panel === 'overlay'
        ? { width: PANEL_WIDTH, left: RAIL_WIDTH, background: 'var(--mantine-color-default)' }
        : { display: 'none' };

  return (
    <FrameSlotsContext value={slots}>
      <Box
        className={classes['root']}
        style={{
          gridTemplateColumns: `${String(railColumn)}px ${String(panelColumn)}px minmax(0, 1fr)`,
          gridTemplateRows: `${String(TITLE_ROW_HEIGHT)}px minmax(0, 1fr)`,
        }}
      >
        <div
          className={classes['rail']}
          data-sheet={layout.rail === 'overlay' ? '' : undefined}
          style={railStyle}
          inert={layout.rail === 'hidden'}
        >
          <div className={classes['railDrag']} data-tauri-drag-region />
          <div className={classes['railBody']}>
            <Rail />
          </div>
        </div>
        <div
          ref={setPanelHost}
          className={classes['panel']}
          data-sheet={layout.panel === 'overlay' ? '' : undefined}
          style={panelStyle}
          inert={layout.panel === 'hidden'}
          data-panel={layout.panel}
        />
        {buttonShown ? (
          <div className={classes['topLeft']}>
            <Tooltip label={`${label} ${noun}`} position="bottom" openDelay={300}>
              <ActionIcon
                className={classes['sidebarButton']}
                style={layout.panel === 'column' ? { right: 8 } : { left: 80 }}
                variant="subtle"
                color="gray"
                size={28}
                aria-label={`${label} ${noun}`}
                aria-expanded={band === ShellBand.Wide ? !panelHidden : overlayOpen}
                onClick={toggleSidebar}
              >
                <IconLayoutSidebar size={16} stroke={1.6} />
              </ActionIcon>
            </Tooltip>
          </div>
        ) : null}
        <div
          ref={setTitleHost}
          className={classes['titleRow']}
          style={{
            paddingLeft: titleStart,
            ...(layout.rail === 'shown' ? {} : { gridColumn: '1 / -1' }),
          }}
          data-title-row=""
          data-pipe={layout.panel === 'column' ? '' : undefined}
          data-tauri-drag-region
        />
        <div
          className={classes['surface']}
          style={narrow ? { gridColumn: '1 / -1', margin: '0 6px 6px' } : { margin: '0 8px 8px 0' }}
        >
          {banner}
          <div className={classes['content']}>{children}</div>
          <div ref={setDrawerHost} className={classes['drawerLayer']} />
        </div>
        {layout.rail === 'overlay' || layout.panel === 'overlay' ? (
          <div
            className={classes['backdrop']}
            style={{ left: railColumn }}
            data-frame-backdrop
            onClick={() => {
              setOpenedAt(null);
            }}
            aria-hidden="true"
          />
        ) : null}
      </Box>
    </FrameSlotsContext>
  );
}

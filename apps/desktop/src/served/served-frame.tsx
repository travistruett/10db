import { ActionIcon } from '@mantine/core';
import {
  IconBuildingFactory2,
  IconInbox,
  IconListDetails,
  IconSettings,
} from '@tabler/icons-react';
import { Link, Outlet } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';
import { useEventStream } from '../daemon/events';
import { CountBadge, CountTone } from '../shell/count-badge';
import { FrameSlotsContext, type FrameSlots } from '../shell/frame-slots';
import { ReconnectingIndicator } from '../shell/reconnecting-indicator';
import { UnsavedGuardProvider } from '../shell/unsaved-guard';
import { useOpenInboxCount } from '../views/inbox/inbox-count';
import { takeDirectCard } from './deep-link';
import classes from './served-frame.module.css';

/** The phone's three places, in the bottom bar. */
function Places() {
  const open = useOpenInboxCount();
  const link = {
    className: classes['place'] ?? '',
    activeProps: { 'data-active': '', 'aria-current': 'page' as const },
  };
  return (
    <nav className={classes['nav']} aria-label="Places">
      <Link to="/inbox" {...link}>
        <span className={classes['placeIcon']}>
          <IconInbox size={22} stroke={1.6} aria-hidden="true" />
          {open > 0 ? (
            <span className={classes['placeCount']}>
              <CountBadge count={open} tone={CountTone.Attention} cap={99} phrase="need you" />
            </span>
          ) : null}
        </span>
        Inbox
      </Link>
      <Link to="/factory" {...link}>
        <IconBuildingFactory2 size={22} stroke={1.6} aria-hidden="true" />
        Factory
      </Link>
      <Link to="/settings/$section" params={{ section: 'this-device' }} {...link}>
        <IconSettings size={22} stroke={1.6} aria-hidden="true" />
        Settings
      </Link>
    </nav>
  );
}

/**
 * The phone's frame: the narrow band's layout without the window's chrome. One bar holds the view's title, a
 * button that shows the view's list of cards as a sheet over the content, and the connection's pill; the three
 * places are below. Views draw into it as they do into the window's (`FrameSlotsContext`).
 */
export function ServedFrame() {
  useEventStream();
  const [titleHost, setTitleHost] = useState<HTMLElement | null>(null);
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);
  const [drawerHost, setDrawerHost] = useState<HTMLElement | null>(null);
  const [hasPanel, setHasPanel] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // A view's list shows first, so the phone opens on what is waiting; picking a row closes it.
  const registerPanel = useCallback(() => {
    setHasPanel(true);
    setSheetOpen(!takeDirectCard());
    return () => {
      setHasPanel(false);
      setSheetOpen(false);
    };
  }, []);
  const showPanel = useCallback(() => {
    setSheetOpen(true);
  }, []);
  const closeSheet = useCallback(() => {
    setSheetOpen(false);
  }, []);

  const panelShown = hasPanel && sheetOpen;
  const slots = useMemo<FrameSlots>(
    () => ({ titleHost, panelHost, drawerHost, panelShown, showPanel, closeSheet, registerPanel }),
    [titleHost, panelHost, drawerHost, panelShown, showPanel, closeSheet, registerPanel],
  );

  return (
    <FrameSlotsContext value={slots}>
      <UnsavedGuardProvider>
        <div className={classes['root']}>
          <div className={classes['bar']}>
            {hasPanel ? (
              <ActionIcon
                variant="subtle"
                color="gray"
                size={32}
                aria-label={sheetOpen ? 'Show the card' : 'Show the list'}
                aria-expanded={sheetOpen}
                onClick={() => {
                  setSheetOpen(!sheetOpen);
                }}
              >
                <IconListDetails size={20} stroke={1.6} />
              </ActionIcon>
            ) : null}
            <div ref={setTitleHost} className={classes['titleHost']} />
            <ReconnectingIndicator />
          </div>
          <div className={classes['content']}>
            <main className={classes['main']}>
              <Outlet />
            </main>
            <div ref={setDrawerHost} className={classes['drawerLayer']} />
          </div>
          <div
            ref={setPanelHost}
            className={classes['panel']}
            data-shown={panelShown ? '' : undefined}
          />
          <Places />
        </div>
      </UnsavedGuardProvider>
    </FrameSlotsContext>
  );
}

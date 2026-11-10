import {
  AreaRole,
  type AreaDef,
  type PagesProposalDto,
  type ProjectViewDto,
} from '@10db/contracts';
import {
  Anchor,
  Button,
  Checkbox,
  Code,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { usePatchProject } from '../../daemon/queries';
import { FormModal } from '../../shell/form-modal';
import { SettingsSectionKey } from '../settings/sections';

// Workbench spec §4.2 and §7.1: a project with no page area cannot open a pass, so the Workbench says
// why and offers the area proposer, whose pages the builder ticks, renames and saves.

export interface NoPageAreasProps {
  readonly onPropose: () => void;
}

/** In place of the picker when the project has no page area. */
export function NoPageAreas({ onPropose }: NoPageAreasProps) {
  return (
    <Stack gap="md" maw={640} align="flex-start">
      <Text>
        A pass works on pages, and this project has no page area yet. A page area is the files of
        one screen of your app, with the route that shows it; each page in a pass is one agent
        working on it with you.
      </Text>
      <Group gap="md">
        <Button onClick={onPropose}>Propose Page Areas</Button>
        <Anchor
          size="sm"
          renderRoot={(props) => (
            <Link
              {...props}
              to="/settings/$section"
              params={{ section: SettingsSectionKey.Areas }}
            />
          )}
        >
          Settings › Areas and hazards
        </Anchor>
      </Group>
    </Stack>
  );
}

/** A proposed page as the builder edits it before saving. */
interface PageDraft {
  /** The name it was proposed under, which labels its row while the name is edited. */
  readonly proposed: string;
  readonly add: boolean;
  readonly name: string;
  readonly route: string;
  readonly globs: readonly string[];
  readonly reason: string;
}

function draftsOf(proposal: PagesProposalDto): PageDraft[] {
  return proposal.pages.map((page) => ({
    proposed: page.name,
    add: true,
    name: page.name,
    route: page.route ?? '',
    globs: page.globs,
    reason: page.reason,
  }));
}

/** The ticked drafts as page areas. */
function pageAreas(drafts: readonly PageDraft[]): AreaDef[] {
  return drafts
    .filter((draft) => draft.add)
    .map((draft) => {
      const route = draft.route.trim();
      return {
        name: draft.name.trim(),
        globs: [...draft.globs],
        role: AreaRole.Page,
        ...(route === '' ? {} : { route }),
      };
    });
}

export interface ProposePagesModalProps {
  readonly project: ProjectViewDto;
  readonly opened: boolean;
  readonly onClose: () => void;
  /** Asks the proposer for page areas once, when the dialog opens. */
  readonly propose: () => Promise<PagesProposalDto>;
}

/**
 * The proposer's page areas, each ticked, with its name and route editable and why it was proposed;
 * the areas it left out with why. Save adds the ticked ones after the project's own areas.
 */
export function ProposePagesModal({ project, opened, onClose, propose }: ProposePagesModalProps) {
  const [drafts, setDrafts] = useState<PageDraft[]>([]);
  const proposal = useMutation({
    mutationFn: () => propose(),
    onSuccess: (answer) => {
      setDrafts(draftsOf(answer));
    },
  });
  const patch = usePatchProject(project.id);
  // The proposer runs a model, so a remount must not ask twice.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    proposal.mutate();
  }, [proposal]);
  const edit = (proposed: string, change: Partial<PageDraft>) => {
    setDrafts((list) =>
      list.map((draft) => (draft.proposed === proposed ? { ...draft, ...change } : draft)),
    );
  };
  const adding = pageAreas(drafts);
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="Propose Page Areas"
      error={proposal.error?.message ?? patch.error?.message ?? null}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={adding.length === 0}
            loading={patch.isPending}
            onClick={() => {
              patch.mutate({ areas: [...project.areas, ...adding] }, { onSuccess: onClose });
            }}
          >
            Save Page Areas
          </Button>
        </>
      }
    >
      {proposal.isPending ? (
        <Group gap="sm">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            Reading the repository for its pages…
          </Text>
        </Group>
      ) : (
        <Stack gap="lg">
          {drafts.map((draft) => (
            <Stack key={draft.proposed} gap="xs" role="group" aria-label={draft.proposed}>
              <Checkbox
                aria-label={`Add ${draft.proposed}`}
                label={draft.name}
                checked={draft.add}
                onChange={(event) => {
                  edit(draft.proposed, { add: event.currentTarget.checked });
                }}
              />
              <Text size="xs" c="dimmed">
                {draft.reason}
              </Text>
              <Group gap="sm" grow>
                <TextInput
                  label="Name"
                  value={draft.name}
                  disabled={!draft.add}
                  onChange={(event) => {
                    edit(draft.proposed, { name: event.currentTarget.value });
                  }}
                />
                <TextInput
                  label="Route"
                  value={draft.route}
                  disabled={!draft.add}
                  onChange={(event) => {
                    edit(draft.proposed, { route: event.currentTarget.value });
                  }}
                />
              </Group>
              <Text size="xs" c="dimmed">
                {draft.globs.map((glob) => (
                  <Code key={glob} mr={4}>
                    {glob}
                  </Code>
                ))}
              </Text>
            </Stack>
          ))}
          {(proposal.data?.skipped ?? []).map((skip) => (
            <Text key={skip.name} size="xs" c="dimmed">
              {`${skip.name}: ${skip.reason}`}
            </Text>
          ))}
        </Stack>
      )}
    </FormModal>
  );
}

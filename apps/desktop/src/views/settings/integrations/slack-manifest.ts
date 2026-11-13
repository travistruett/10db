/** The Slack app's manifest, as `docs/slack-app.md` gives it; a repo test keeps the two the same. */
export const SLACK_MANIFEST = `_metadata:
  major_version: 2
display_information:
  name: 10db
  description: Asks you questions for a builder's 10db projects and waits for your answer.
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: 10db
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:write
      - im:history
      - mpim:write
      - mpim:history
      - reactions:read
      - reactions:write
      - users:read
      - users:read.email
settings:
  event_subscriptions:
    bot_events:
      - message.im
      - message.mpim
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;

export const SLACK_APPS_URL = 'https://api.slack.com/apps';

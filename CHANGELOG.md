# Changelog

## 0.1.0 (2026-10-28)


### Features

* **daemon:** add the engine core with the fake adapter (m1a) ([#11](https://github.com/travistruett/10db/issues/11)) ([c36abd8](https://github.com/travistruett/10db/commit/c36abd8bf510f8ae54f7ee7c4eb2705a2df161e2))
* **daemon:** always run lanes in the sandbox and drop auto mode ([#73](https://github.com/travistruett/10db/issues/73)) ([7e9ab64](https://github.com/travistruett/10db/commit/7e9ab64a4e1cde2130ade11e7560a4b4d4a5d2fd))
* **daemon:** deliver each batch on one branch and one pull request ([#54](https://github.com/travistruett/10db/issues/54)) ([531bf60](https://github.com/travistruett/10db/commit/531bf60e45843ce95991e8ca5388bc0670937ebe))
* **daemon:** let a project allow extra commands so lanes don't wait on routine tools ([#57](https://github.com/travistruett/10db/issues/57)) ([f0e6f61](https://github.com/travistruett/10db/commit/f0e6f61ac430a5fe9db3dfeedf5615e64369023c))
* **daemon:** let each project choose auto mode in settings ([#68](https://github.com/travistruett/10db/issues/68)) ([6cb2301](https://github.com/travistruett/10db/commit/6cb230152d89b052327e528e0ed29b75ddc0038c))
* **daemon:** let lanes run in auto mode and stop a card per test run ([#63](https://github.com/travistruett/10db/issues/63)) ([162a6f8](https://github.com/travistruett/10db/commit/162a6f887e3a7ecab8b64ed6716e53a394ad0e16))
* **daemon:** pin the daemon's git and make git state read-only to lanes ([#75](https://github.com/travistruett/10db/issues/75)) ([a0c879c](https://github.com/travistruett/10db/commit/a0c879c3b03a5e3a16259ff779f155b796bc1da0))
* **daemon:** propose the next tasks with the picker rules and a candidates route ([#52](https://github.com/travistruett/10db/issues/52)) ([8958b1c](https://github.com/travistruett/10db/commit/8958b1cd01a9708c9976b5406a9d14e447aafab1))
* **daemon:** run approved repo mcp servers in the sandbox ([#79](https://github.com/travistruett/10db/issues/79)) ([5fb7565](https://github.com/travistruett/10db/commit/5fb75651d050627c23660f4480e474f013814b61))
* **daemon:** run lanes under the OS sandbox behind TENDB_LANE_SANDBOX ([#69](https://github.com/travistruett/10db/issues/69)) ([8d49fbd](https://github.com/travistruett/10db/commit/8d49fbd97b9160a8579ab9a4f443eeb5dabb546c))
* **daemon:** run real claude sessions and add the bare desktop ui (m1b) ([#16](https://github.com/travistruett/10db/issues/16)) ([5935683](https://github.com/travistruett/10db/commit/5935683391e5cb0a37b7a2c2f5718642fb3b3720))
* **daemon:** run tasks through flows of personas on aa-scored model profiles (m2a) ([#24](https://github.com/travistruett/10db/issues/24)) ([fe48688](https://github.com/travistruett/10db/commit/fe48688e88df56d227675538dfc5e0c19c094a8f))
* **daemon:** run the gate in the sandbox ([#78](https://github.com/travistruett/10db/issues/78)) ([6f63ae4](https://github.com/travistruett/10db/commit/6f63ae4c227b7f21e7b4774eb2acc776d0a0feca))
* **daemon:** turn accepted proposals into tasks and surface failed model data syncs ([#60](https://github.com/travistruett/10db/issues/60)) ([e8286e4](https://github.com/travistruett/10db/commit/e8286e4c020bd0b692b3d5515832df91cedb28b2))
* **desktop:** add the 10db app icon in geist ([#45](https://github.com/travistruett/10db/issues/45)) ([6cde75e](https://github.com/travistruett/10db/commit/6cde75eea61c6d0c936abde81859516144bd32e0))
* **desktop:** add the accounts settings screen ([#74](https://github.com/travistruett/10db/issues/74)) ([b534b54](https://github.com/travistruett/10db/commit/b534b542ca39217e00aada0c9eeab5ba92293db2))
* **desktop:** keep shipped batches reachable, surface failed model syncs and log delivery ([#65](https://github.com/travistruett/10db/issues/65)) ([2d38137](https://github.com/travistruett/10db/commit/2d38137eb5afb944e0029a35a7b42c4a5a8a21a0))
* **desktop:** m2b part a, the board, human columns and settings ([#47](https://github.com/travistruett/10db/issues/47)) ([3135285](https://github.com/travistruett/10db/commit/313528504b7b2219fb76081d6fc7d999546923e2))
* **desktop:** note a self-clearing model sync failure quietly in the factory header ([#76](https://github.com/travistruett/10db/issues/76)) ([2620f66](https://github.com/travistruett/10db/commit/2620f662a0fc36c23930f09ee602bddb1f0c3482))
* **desktop:** pick and approve a batch from the board (m2b part b) ([#70](https://github.com/travistruett/10db/issues/70)) ([502a179](https://github.com/travistruett/10db/commit/502a179ae5e8f04009b8bcdf5a09c0cc4c7014bc))
* **desktop:** put the window controls in the header and give the menu bar a template icon ([#72](https://github.com/travistruett/10db/issues/72)) ([e8cb730](https://github.com/travistruett/10db/commit/e8cb73055a44733984d59e6c75476637890a5717))


### Bug Fixes

* **daemon:** carry every lane variable through the sandbox env file ([#77](https://github.com/travistruett/10db/issues/77)) ([16a3c66](https://github.com/travistruett/10db/commit/16a3c664894c1ae6aa05afcdc327fa465877cd28))
* **daemon:** close the always-allow gaps for bare runners and forwarding subcommands ([#64](https://github.com/travistruett/10db/issues/64)) ([60dc3a9](https://github.com/travistruett/10db/commit/60dc3a9c93990d40ce2dd33b84ba449e873d2378))
* **daemon:** follow the PR template and cut branch names at a word boundary ([#58](https://github.com/travistruett/10db/issues/58)) ([1bb8277](https://github.com/travistruett/10db/commit/1bb827761ea4710ff95fd9f4e87058632e4bccbf))
* **daemon:** hand off resumed sessions at their conversation threshold and pass the m1 live run ([#19](https://github.com/travistruett/10db/issues/19)) ([e513535](https://github.com/travistruett/10db/commit/e5135352a1c8e6e76423db0b87c1d295dfabd8e7))
* **daemon:** keep git reads off index.lock so concurrent commits succeed ([#44](https://github.com/travistruett/10db/issues/44)) ([1412e46](https://github.com/travistruett/10db/commit/1412e4626dcd0fb96270d24a1d78ee14128dc7b8))
* **daemon:** send back uncommitted steps and store whole commands for package runners ([#59](https://github.com/travistruett/10db/issues/59)) ([33a138c](https://github.com/travistruett/10db/commit/33a138ca9473f260b084469193f14522d15f7199))
* **db:** never give two open tasks the same board order ([#56](https://github.com/travistruett/10db/issues/56)) ([bee3f2e](https://github.com/travistruett/10db/commit/bee3f2efe9ac1e94d7b32b6ead0dca0d4843d700))
* **desktop:** run each e2e on free ports so parallel gates never collide ([#43](https://github.com/travistruett/10db/issues/43)) ([c0ff8cb](https://github.com/travistruett/10db/commit/c0ff8cb3f7190b04e86bba08b30f94e33dfa8158))
* **repo:** keep git hook variables out of tests and git subprocesses ([#41](https://github.com/travistruett/10db/issues/41)) ([317ddc7](https://github.com/travistruett/10db/commit/317ddc71acb3184ab10853a554f66613a5461d79))
* **repo:** keep the gate test out of the checkout and document the git CI runs ([#61](https://github.com/travistruett/10db/issues/61)) ([0ba3a32](https://github.com/travistruett/10db/commit/0ba3a32977ca1cbb1c996a063ee8af8589bf1d06))
* **repo:** keep the release-please manifest out of prettier ([#81](https://github.com/travistruett/10db/issues/81)) ([ee6acfb](https://github.com/travistruett/10db/commit/ee6acfb3e72a2a5ee395f37d4ba5d4972b10765e))
* **repo:** turn off auto maintenance in bare test origins too ([#51](https://github.com/travistruett/10db/issues/51)) ([3ce2ed3](https://github.com/travistruett/10db/commit/3ce2ed3a3538fc7bd5be1e01718a21014f7581f7))
* **repo:** turn off git auto maintenance in test repositories ([#46](https://github.com/travistruett/10db/issues/46)) ([0561a70](https://github.com/travistruett/10db/commit/0561a700c4626afb74b5d99336242abc9eb28a16))

## Changelog

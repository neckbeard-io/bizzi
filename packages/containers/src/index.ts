// @bizzi/containers: container workspaces (topology.md §7). Agent sessions of a workspace of kind
// 'container' run inside a container on the machine, reached with `docker exec`, against the dind
// sidecar or another configured daemon, never the host's Docker socket by default.

export { CliDocker, DISABLED_REASON, cleanEnv, dockerError, isNoSuch, resolveDockerTarget, type DockerResult, type DockerRunner, type DockerTarget, type Env } from './docker.ts';
export { DEVCONTAINER_FILES, parseDevcontainer, readDevcontainer, stripJsonc, type DevcontainerRecipe } from './devcontainer.ts';
export {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_IMAGE,
  DEFAULT_NETWORK,
  DEFAULT_PASS_ENV,
  KEEPALIVE,
  LABEL_MACHINE,
  LABEL_MANAGED,
  LABEL_WORKSPACE,
  buildArgs,
  containerName,
  createArgs,
  devcontainerTag,
  execArgs,
  forwardedEnv,
  hostnameFor,
  mountArg,
  parseInspect,
  postCreateArgs,
  reachableMcpServers,
  workspaceMounts,
} from './spec.ts';
export { ContainerManager, recipe, type ContainerManagerOptions } from './manager.ts';
export { DEFAULT_IMAGE_CONTEXT, buildRecipe, createContainersExtension, type ContainersExtension, type ContainersExtensionOptions } from './extension.ts';

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { DesktopTheme, DesktopUpdateChannel } from "@app/contracts";
import { fromLenientJson } from "@app/shared/schemaJson";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveDefaultDesktopUpdateChannel } from "../updates/updateChannels.ts";

export const MIN_MAIN_WINDOW_SIZE = {
  width: 840,
  height: 620,
} as const;

export const DEFAULT_MAIN_WINDOW_SIZE = {
  width: 1100,
  height: 780,
} as const;

/**
 * Persisted geometry for the main window. The size checks are part of the
 * schema, not a later guard: a persisted window smaller than the minimum is
 * unusable, and rejecting it at decode time is what makes the restore path fall
 * back to the default instead of reopening something the user cannot resize
 * their way out of.
 */
export const DesktopWindowBoundsSchema = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_MAIN_WINDOW_SIZE.width)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_MAIN_WINDOW_SIZE.height)),
});
export type DesktopWindowBounds = typeof DesktopWindowBoundsSchema.Type;

export interface DesktopSettings {
  readonly theme: DesktopTheme;
  readonly mainWindowBounds: DesktopWindowBounds | null;
  readonly mainWindowMaximized: boolean;
  readonly updateChannel: DesktopUpdateChannel;
  /**
   * Distinguishes "the user picked this channel" from "this is the default for
   * the build that happens to be running". Without it, someone who explicitly
   * chose `nightly` on a nightly build (and so wrote nothing, because it
   * matched the default) would be silently moved to `latest` the first time
   * they installed a stable build.
   */
  readonly updateChannelConfiguredByUser: boolean;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  theme: "system",
  mainWindowBounds: null,
  mainWindowMaximized: false,
  updateChannel: "latest",
  updateChannelConfiguredByUser: false,
};

/**
 * The defaults for a specific build. A nightly build defaults to the nightly
 * channel, so a fresh install does not immediately try to "update" itself onto
 * a stable release that is older than what is already on disk.
 */
export function resolveDefaultDesktopSettings(appVersion: string): DesktopSettings {
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    updateChannel: resolveDefaultDesktopUpdateChannel(appVersion),
  };
}

// Deliberately looser than `DesktopWindowBoundsSchema`: the document accepts
// any numbers so a stale or hand-edited bounds block does not fail the whole
// settings decode, and `normalizeMainWindowBounds` is what rejects it.
const DesktopWindowBoundsDocument = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});

const DesktopSettingsDocument = Schema.Struct({
  theme: Schema.optionalKey(DesktopTheme),
  mainWindowBounds: Schema.optionalKey(Schema.NullOr(DesktopWindowBoundsDocument)),
  mainWindowMaximized: Schema.optionalKey(Schema.Boolean),
  updateChannel: Schema.optionalKey(DesktopUpdateChannel),
  updateChannelConfiguredByUser: Schema.optionalKey(Schema.Boolean),
});
type DesktopSettingsDocument = typeof DesktopSettingsDocument.Type;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// Lenient on the way in: this file is on disk where a human can open it, and a
// `//` note or a trailing comma must not silently reset every setting.
const DesktopSettingsJson = fromLenientJson(DesktopSettingsDocument);
const decodeDesktopSettingsJson = Schema.decodeUnknownEffect(DesktopSettingsJson);
const encodeDesktopSettingsJson = Schema.encodeUnknownEffect(DesktopSettingsJson);
const decodeDesktopWindowBounds = Schema.decodeUnknownOption(DesktopWindowBoundsSchema);
const desktopWindowBoundsEquivalence = Schema.toEquivalence(DesktopWindowBoundsSchema);

/** `null` for anything that is not usable geometry, so callers fall back. */
export function normalizeMainWindowBounds(value: unknown): DesktopWindowBounds | null {
  return Option.getOrNull(decodeDesktopWindowBounds(value));
}

export interface DesktopSettingsChange {
  readonly settings: DesktopSettings;
  readonly changed: boolean;
}

const settingsChange = (settings: DesktopSettings, changed: boolean): DesktopSettingsChange => ({
  settings,
  changed,
});

const DesktopSettingsWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-settings-file",
]);
type DesktopSettingsWriteOperation = typeof DesktopSettingsWriteOperation.Type;

export class DesktopSettingsWriteError extends Schema.TaggedError<DesktopSettingsWriteError>()(
  "DesktopSettingsWriteError",
  {
    operation: DesktopSettingsWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop settings write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopAppSettings extends Context.Service<
  DesktopAppSettings,
  {
    readonly load: Effect.Effect<DesktopSettings>;
    readonly get: Effect.Effect<DesktopSettings>;
    readonly setTheme: (
      theme: DesktopTheme,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setMainWindowBounds: (
      bounds: DesktopWindowBounds,
      isMaximized: boolean,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setUpdateChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
  }
>()("@app/desktop/settings/DesktopAppSettings") {}

function normalizeDocument(
  parsed: DesktopSettingsDocument,
  defaults: DesktopSettings,
): DesktopSettings {
  const updateChannelConfiguredByUser = parsed.updateChannelConfiguredByUser === true;
  const mainWindowBounds = normalizeMainWindowBounds(parsed.mainWindowBounds);
  return {
    theme: parsed.theme ?? defaults.theme,
    mainWindowBounds,
    // Maximized is only meaningful alongside bounds to un-maximize back into.
    mainWindowMaximized: mainWindowBounds !== null && parsed.mainWindowMaximized === true,
    // A channel the user never chose tracks the running build rather than
    // whatever was persisted by a differently-channelled build before it.
    updateChannel: updateChannelConfiguredByUser
      ? (parsed.updateChannel ?? defaults.updateChannel)
      : defaults.updateChannel,
    updateChannelConfiguredByUser,
  };
}

// Fields left at their default are omitted so a later change to a default value
// still reaches users who never overrode it.
function toDocument(settings: DesktopSettings, defaults: DesktopSettings): DesktopSettingsDocument {
  const document: Mutable<DesktopSettingsDocument> = {};
  if (settings.theme !== defaults.theme) document.theme = settings.theme;
  if (settings.mainWindowBounds !== defaults.mainWindowBounds) {
    document.mainWindowBounds = settings.mainWindowBounds;
  }
  if (settings.mainWindowMaximized !== defaults.mainWindowMaximized) {
    document.mainWindowMaximized = settings.mainWindowMaximized;
  }
  if (settings.updateChannel !== defaults.updateChannel) {
    document.updateChannel = settings.updateChannel;
  }
  if (settings.updateChannelConfiguredByUser !== defaults.updateChannelConfiguredByUser) {
    document.updateChannelConfiguredByUser = settings.updateChannelConfiguredByUser;
  }
  return document;
}

function setTheme(settings: DesktopSettings, theme: DesktopTheme): DesktopSettings {
  return settings.theme === theme ? settings : { ...settings, theme };
}

// Returning the same object when nothing moved matters here: `persist` skips
// the disk write on identity, and this is called on every resize/move tick.
function setMainWindowBounds(
  settings: DesktopSettings,
  bounds: DesktopWindowBounds,
  isMaximized: boolean,
): DesktopSettings {
  return settings.mainWindowBounds !== null &&
    desktopWindowBoundsEquivalence(settings.mainWindowBounds, bounds) &&
    settings.mainWindowMaximized === isMaximized
    ? settings
    : { ...settings, mainWindowBounds: bounds, mainWindowMaximized: isMaximized };
}

// Selecting a channel always records that the choice was deliberate, even when
// it happens to match the current build's default.
function setUpdateChannel(
  settings: DesktopSettings,
  updateChannel: DesktopUpdateChannel,
): DesktopSettings {
  return settings.updateChannel === updateChannel && settings.updateChannelConfiguredByUser
    ? settings
    : { ...settings, updateChannel, updateChannelConfiguredByUser: true };
}

function readSettings(
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
  defaults: DesktopSettings,
): Effect.Effect<DesktopSettings> {
  return fileSystem.readFileString(settingsPath).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(defaults),
        onSome: (raw) =>
          decodeDesktopSettingsJson(raw).pipe(
            Effect.map((parsed) => normalizeDocument(parsed, defaults)),
            Effect.orElseSucceed(() => defaults),
          ),
      }),
    ),
  );
}

// A crash mid-write must not corrupt the settings file, so the document lands
// in an adjacent temp file and is renamed over the target.
const writeSettings = Effect.fn("desktop.settings.writeSettings")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly settingsPath: string;
  readonly settings: DesktopSettings;
  readonly defaultSettings: DesktopSettings;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopSettingsWriteError> {
  const directory = input.path.dirname(input.settingsPath);
  const tempPath = `${input.settingsPath}.${input.suffix}.tmp`;
  const encoded = yield* encodeDesktopSettingsJson(
    toDocument(input.settings, input.defaultSettings),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "encode-document",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "write-temporary-file",
          path: tempPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.rename(tempPath, input.settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSettingsWriteError({
          operation: "replace-settings-file",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const settingsRef = yield* SynchronizedRef.make(environment.defaultDesktopSettings);

  const persist = (
    update: (settings: DesktopSettings) => DesktopSettings,
  ): Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError> =>
    SynchronizedRef.modifyEffect(settingsRef, (settings) => {
      const nextSettings = update(settings);
      if (nextSettings === settings) {
        return Effect.succeed([settingsChange(settings, false), settings] as const);
      }

      return crypto.randomUUIDv4.pipe(
        Effect.map((uuid) => uuid.replace(/-/g, "")),
        Effect.mapError(
          (cause) =>
            new DesktopSettingsWriteError({
              operation: "create-temporary-file-name",
              path: environment.desktopSettingsPath,
              cause,
            }),
        ),
        Effect.flatMap((suffix) =>
          writeSettings({
            fileSystem,
            path,
            settingsPath: environment.desktopSettingsPath,
            settings: nextSettings,
            defaultSettings: environment.defaultDesktopSettings,
            suffix,
          }),
        ),
        Effect.as([settingsChange(nextSettings, true), nextSettings] as const),
      );
    });

  return DesktopAppSettings.of({
    get: SynchronizedRef.get(settingsRef),
    load: Effect.gen(function* () {
      const settings = yield* readSettings(
        fileSystem,
        environment.desktopSettingsPath,
        environment.defaultDesktopSettings,
      );
      return yield* SynchronizedRef.setAndGet(settingsRef, settings);
    }).pipe(Effect.withSpan("desktop.settings.load")),
    setTheme: (theme) =>
      persist((settings) => setTheme(settings, theme)).pipe(
        Effect.withSpan("desktop.settings.setTheme", { attributes: { theme } }),
      ),
    setMainWindowBounds: (bounds, isMaximized) =>
      persist((settings) => setMainWindowBounds(settings, bounds, isMaximized)).pipe(
        Effect.withSpan("desktop.settings.setMainWindowBounds", {
          attributes: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            isMaximized,
          },
        }),
      ),
    setUpdateChannel: (channel) =>
      persist((settings) => setUpdateChannel(settings, channel)).pipe(
        Effect.withSpan("desktop.settings.setUpdateChannel", {
          attributes: { channel },
        }),
      ),
  });
});

export const layer = Layer.effect(DesktopAppSettings, make);

export const layerTest = (initialSettings: DesktopSettings = DEFAULT_DESKTOP_SETTINGS) =>
  Layer.effect(
    DesktopAppSettings,
    Effect.gen(function* () {
      const settingsRef = yield* SynchronizedRef.make(initialSettings);
      const update = (f: (settings: DesktopSettings) => DesktopSettings) =>
        SynchronizedRef.modify(settingsRef, (settings) => {
          const nextSettings = f(settings);
          return [settingsChange(nextSettings, nextSettings !== settings), nextSettings] as const;
        });

      return DesktopAppSettings.of({
        get: SynchronizedRef.get(settingsRef),
        load: SynchronizedRef.get(settingsRef),
        setTheme: (theme) => update((settings) => setTheme(settings, theme)),
        setMainWindowBounds: (bounds, isMaximized) =>
          update((settings) => setMainWindowBounds(settings, bounds, isMaximized)),
        setUpdateChannel: (channel) => update((settings) => setUpdateChannel(settings, channel)),
      });
    }),
  );

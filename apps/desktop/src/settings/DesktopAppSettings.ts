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

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

export interface DesktopSettings {
  readonly theme: DesktopTheme;
  readonly updateChannel: DesktopUpdateChannel;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  theme: "system",
  updateChannel: "latest",
};

const DesktopSettingsDocument = Schema.Struct({
  theme: Schema.optionalKey(DesktopTheme),
  updateChannel: Schema.optionalKey(DesktopUpdateChannel),
});
type DesktopSettingsDocument = typeof DesktopSettingsDocument.Type;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const DesktopSettingsJson = Schema.fromJsonString(DesktopSettingsDocument);
const decodeDesktopSettingsJson = Schema.decodeUnknownEffect(DesktopSettingsJson);
const encodeDesktopSettingsJson = Schema.encodeUnknownEffect(DesktopSettingsJson);

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
    readonly setUpdateChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
  }
>()("@app/desktop/settings/DesktopAppSettings") {}

function normalizeDocument(parsed: DesktopSettingsDocument): DesktopSettings {
  return {
    theme: parsed.theme ?? DEFAULT_DESKTOP_SETTINGS.theme,
    updateChannel: parsed.updateChannel ?? DEFAULT_DESKTOP_SETTINGS.updateChannel,
  };
}

// Fields left at their default are omitted so a later change to a default value
// still reaches users who never overrode it.
function toDocument(settings: DesktopSettings, defaults: DesktopSettings): DesktopSettingsDocument {
  const document: Mutable<DesktopSettingsDocument> = {};
  if (settings.theme !== defaults.theme) document.theme = settings.theme;
  if (settings.updateChannel !== defaults.updateChannel) {
    document.updateChannel = settings.updateChannel;
  }
  return document;
}

function setTheme(settings: DesktopSettings, theme: DesktopTheme): DesktopSettings {
  return settings.theme === theme ? settings : { ...settings, theme };
}

function setUpdateChannel(
  settings: DesktopSettings,
  updateChannel: DesktopUpdateChannel,
): DesktopSettings {
  return settings.updateChannel === updateChannel ? settings : { ...settings, updateChannel };
}

function readSettings(
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
): Effect.Effect<DesktopSettings> {
  return fileSystem.readFileString(settingsPath).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(DEFAULT_DESKTOP_SETTINGS),
        onSome: (raw) =>
          decodeDesktopSettingsJson(raw).pipe(
            Effect.map(normalizeDocument),
            Effect.orElseSucceed(() => DEFAULT_DESKTOP_SETTINGS),
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
      const settings = yield* readSettings(fileSystem, environment.desktopSettingsPath);
      return yield* SynchronizedRef.setAndGet(settingsRef, settings);
    }).pipe(Effect.withSpan("desktop.settings.load")),
    setTheme: (theme) =>
      persist((settings) => setTheme(settings, theme)).pipe(
        Effect.withSpan("desktop.settings.setTheme", { attributes: { theme } }),
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
        setUpdateChannel: (channel) => update((settings) => setUpdateChannel(settings, channel)),
      });
    }),
  );

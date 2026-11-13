// Dynamic Expo config. A development build can sit next to the production app on
// the same device via APP_VARIANT=development (distinct id + name).
const IS_DEV = process.env.APP_VARIANT === 'development';

const APP_ID = IS_DEV ? 'so.oxy.move.dev' : 'so.oxy.move';
const APP_NAME = IS_DEV ? 'Oxy Move (Dev)' : 'Oxy Move';

// Oxy Move's public client id (ApplicationCredential publicKey, not a secret):
// the app the OTA manifest URL names. The JS reads the same id from
// EXPO_PUBLIC_OXY_CLIENT_ID, which eas.json's production env sets to this value.
const OXY_CLIENT_ID = 'oxy_dk_e153bca818b231446c63539a59cbafc0076948c10453e77a';

module.exports = {
  expo: {
    name: APP_NAME,
    slug: 'move',
    scheme: 'oxymove',
    version: '0.2.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: APP_ID,
    },
    android: {
      package: APP_ID,
    },
    web: {
      bundler: 'metro',
      output: 'single',
    },
    plugins: [
      // SDK 58 code-splits routes on web by default; keep the single eager
      // bundle this app shipped on SDK 57.
      ['expo-router', { asyncRoutes: { web: false } }],
      [
        'expo-splash-screen',
        {
          backgroundColor: '#faf1f6',
          dark: { backgroundColor: '#100d10' },
        },
      ],
      // Dictation and voice calls with Alia (`@gemies/sdk`) recognise speech on
      // the device; the plugin writes the two iOS purpose strings and the
      // Android RECORD_AUDIO permission.
      [
        'react-native-audio-api',
        {
          iosMicrophonePermission: 'Allow Oxy Move to hear what you dictate and say to Alia.',
          iosBackgroundMode: false,
          androidForegroundService: false,
          androidPermissions: ['android.permission.RECORD_AUDIO'],
        },
      ],
      // Shared Oxy native config: iOS keychain group, expo-build-properties
      // defaults, and the Oxy signature permissions (withOxySharedPermissions)
      // that let this app ask Commons for the identity. Own Android UID. Release
      // signing (OXY_UPLOAD_* Gradle properties) is applied by the services
      // plugin the preset includes.
      // `gifEnabled`/`webpEnabled: false` (Expo SDK 58+) leave Fresco's GIF and WebP
      // decoders out of the Android build: nothing here draws a GIF or animated WebP
      // through react-native's own Image (Bloom and @oxy.so/services use expo-image).
      ['@oxy.so/app-preset', { android: { gifEnabled: false, webpEnabled: false } }],
      // Oxy Updates (OTA): JS-only changes reach installed binaries of the same
      // `version` (runtime policy appVersion); publish-update.yml publishes them.
      ['@oxy.so/app-preset/plugin/withOxyUpdates', { clientId: OXY_CLIENT_ID }],
    ],
    extra: {
      router: {},
    },
  },
};

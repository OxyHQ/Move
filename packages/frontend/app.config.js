// Dynamic Expo config. A development build can sit next to the production app on
// the same device via APP_VARIANT=development (distinct id + name).
const IS_DEV = process.env.APP_VARIANT === 'development';

const APP_ID = IS_DEV ? 'so.oxy.move.dev' : 'so.oxy.move';
const APP_NAME = IS_DEV ? 'Oxy Move (Dev)' : 'Oxy Move';

module.exports = {
  expo: {
    name: APP_NAME,
    slug: 'move',
    scheme: 'oxymove',
    version: '0.1.0',
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
      'expo-router',
      [
        'expo-splash-screen',
        {
          backgroundColor: '#faf1f6',
          dark: { backgroundColor: '#100d10' },
        },
      ],
      // Dictation and voice calls with Alia (`@alia.onl/sdk`) recognise speech on
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
      // that let this app ask Commons for the identity. Own Android UID.
      ['@oxy.so/app-preset', {}],
    ],
    extra: {
      router: {},
    },
  },
};

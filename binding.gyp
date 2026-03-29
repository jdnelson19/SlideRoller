{
  "variables": {
    "decklink_framework_dir%": "<!(node -p \"process.env.DECKLINK_FRAMEWORK_DIR || '/Library/Frameworks'\")"
  },
  "targets": [
    {
      "target_name": "decklink_addon",
      "sources": [
        "src/native/decklink-addon/decklink_addon.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(module_root_dir)/.decklink-sdk/include"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags_cc": [
        "-std=c++17"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "FRAMEWORK_SEARCH_PATHS": [
              "<(decklink_framework_dir)"
            ]
          },
          "libraries": [
            "-framework CoreFoundation"
          ]
        }],
        ["OS=='win'", {
          "libraries": [
            "DeckLinkAPI.lib"
          ]
        }]
      ]
    }
  ]
}

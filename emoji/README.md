# Custom emoji

The player's buttons use custom emoji from Microsoft's
[Fluent Emoji](https://github.com/microsoft/fluentui-emoji) (MIT). A workspace
without them sees the standard Slack emoji instead, chosen at startup; listing
the workspace's emoji needs the `emoji:read` bot scope, and without it the
standard ones are used.

| Emoji name               | Fluent Emoji        | Standard fallback                                          |
| ------------------------ | ------------------- | ---------------------------------------------------------- |
| `ms-play`                | Play button         | `:arrow_forward:`                                          |
| `ms-pause`               | Pause button        | `:double_vertical_bar:`                                    |
| `ms-skip-forward`        | Next track button   | `:black_right_pointing_double_triangle_with_vertical_bar:` |
| `ms-skip-back`           | Last track button   | `:black_left_pointing_double_triangle_with_vertical_bar:`  |
| `ms-fast-forward`        | Fast-forward button | `:fast_forward:`                                           |
| `ms-rewind`              | Fast reverse button | `:rewind:`                                                 |
| `ms-sparkling-heart`     | Sparkling heart     | `:sparkling_heart:`                                        |
| `ms-floppy-disk`         | Floppy disk         | `:floppy_disk:`                                            |
| `ms-speaker-loud-volume` | Speaker high volume | `:loud_sound:`                                             |
| `ms-speaker-low-volume`  | Speaker low volume  | `:speaker:`                                                |
| `ms-3-00`                | Three o'clock       | `:clock3:`                                                 |

## Adding them

The images are in this folder, each named as the player uses it.

1. In Slack, open **Customize workspace → Emoji → Add custom emoji**.
2. Add each `.png` here under its file name without `.png` (`ms-play`, ...).
3. Restart HuddleFM, which then uses them.

The images are Microsoft's, under the MIT license in [LICENSE](LICENSE).

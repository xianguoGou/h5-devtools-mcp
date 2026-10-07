#!/bin/bash
# Minimal adb stand-in: one authorized device, one unauthorized; forwards to $FAKE_PORT.
if [ "$1" = "-s" ]; then shift 2; fi
case "$1" in
  devices)
    printf "List of devices attached\nFAKE123                device usb:1-1 product:x model:Pixel_7 device:x transport_id:1\nBAD456                 unauthorized usb:1-2 transport_id:2\n\n";;
  shell)
    if [ "$3" = "/proc/net/unix" ]; then
      printf "Num       RefCount Protocol Flags    Type St Inode Path\r\n"
      printf "00000000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_4321\r\n"
      printf "00000000: 00000002 00000000 00010000 0001 01 12399 @webview_devtools_remote_4321\r\n"
    elif [ "$3" = "/proc/4321/cmdline" ]; then
      printf "com.example.trade\0"
    fi;;
  forward)
    [ "$2" = "--list" ] && exit 0
    echo "$FAKE_PORT";;
esac

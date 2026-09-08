# The webview wrapper

**Premise, not a question.** muxterm's native app is a thin wrapper around a webview pointed
at the existing muxterm web app. The web app is the product. The wrapper exists only to give
that webview the platform capabilities a browser tab cannot have — chiefly audio capture and
playback that survive the screen going off, and later camera and file attachment as inputs.

This document designs that wrapper. It does not evaluate whether a wrapper is the right
architecture, and it does not compare one against a from-scratch native client.

**Status: DRAFT — in progress.**


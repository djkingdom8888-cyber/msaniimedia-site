"""Unit tests for lib/stream_relay.py's pure destination-building/validation
logic -- mirrors the spirit of kingdomprodmedia/test/kpm-core.test.js's
streaming section (no subprocess/network involved here; see
tests/test_stream_relay_integration.py for the real ffmpeg/RTMP proof)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import stream_relay as sr


class NormalizeStreamDestinationTests(unittest.TestCase):
    def test_fills_in_defaults_for_empty_entry(self):
        d = sr.normalize_stream_destination({}, index=0)
        self.assertEqual(d["name"], "Destination 1")
        self.assertEqual(d["platform"], "custom")
        self.assertEqual(d["rtmp_url"], "")
        self.assertEqual(d["stream_key"], "")
        self.assertTrue(d["enabled"])  # defaults to enabled for a new entry
        self.assertFalse(d["remember_key"])

    def test_preserves_well_formed_entry(self):
        raw = {
            "name": "My Twitch", "platform": "twitch", "rtmp_url": " rtmp://x/app ",
            "stream_key": "abc123", "enabled": True, "remember_key": True,
        }
        d = sr.normalize_stream_destination(raw)
        self.assertEqual(d["name"], "My Twitch")
        self.assertEqual(d["rtmp_url"], "rtmp://x/app")  # trimmed
        self.assertEqual(d["stream_key"], "abc123")
        self.assertTrue(d["remember_key"])

    def test_explicit_false_is_the_only_way_to_disable(self):
        self.assertTrue(sr.normalize_stream_destination({"enabled": None})["enabled"])
        self.assertTrue(sr.normalize_stream_destination({})["enabled"])
        self.assertFalse(sr.normalize_stream_destination({"enabled": False})["enabled"])

    def test_bad_types_do_not_crash_and_fall_back_to_defaults(self):
        d = sr.normalize_stream_destination({"platform": 42, "rtmp_url": 7, "stream_key": None, "name": ""})
        self.assertEqual(d["platform"], "custom")
        self.assertEqual(d["rtmp_url"], "")
        self.assertEqual(d["stream_key"], "")
        self.assertEqual(d["name"], "Destination 1")


class BuildStreamDestinationTests(unittest.TestCase):
    def test_joins_url_and_key(self):
        self.assertEqual(sr.build_stream_destination("rtmp://a.example/app", "key123"), "rtmp://a.example/app/key123")

    def test_trims_trailing_slash_before_joining(self):
        self.assertEqual(sr.build_stream_destination("rtmp://a.example/app/", "key123"), "rtmp://a.example/app/key123")

    def test_no_key_returns_bare_url(self):
        self.assertEqual(sr.build_stream_destination("rtmp://a.example/app", ""), "rtmp://a.example/app")

    def test_no_url_returns_none(self):
        self.assertIsNone(sr.build_stream_destination("", "key123"))
        self.assertIsNone(sr.build_stream_destination(None, "key123"))

    def test_whitespace_only_url_returns_none(self):
        self.assertIsNone(sr.build_stream_destination("   ", "key123"))


class ResolveEnabledStreamDestinationsTests(unittest.TestCase):
    def test_includes_only_enabled_with_valid_url(self):
        destinations = [
            {"platform": "twitch", "rtmp_url": sr.PLATFORM_PRESETS["twitch"]["rtmp_url"], "stream_key": "k1", "enabled": True},
            {"platform": "youtube", "rtmp_url": sr.PLATFORM_PRESETS["youtube"]["rtmp_url"], "stream_key": "k2", "enabled": False},
            {"platform": "custom", "rtmp_url": "rtmp://custom.example/app", "stream_key": "", "enabled": True},
        ]
        urls = sr.resolve_enabled_stream_destinations(destinations)
        self.assertEqual(urls, [
            sr.PLATFORM_PRESETS["twitch"]["rtmp_url"] + "/k1",
            "rtmp://custom.example/app",
        ])

    def test_disabled_destination_excluded_even_with_valid_url(self):
        destinations = [{"platform": "custom", "rtmp_url": "rtmp://x/app", "stream_key": "k", "enabled": False}]
        self.assertEqual(sr.resolve_enabled_stream_destinations(destinations), [])

    def test_enabled_destination_with_no_url_is_silently_excluded_not_an_error(self):
        destinations = [{"platform": "custom", "rtmp_url": "", "stream_key": "k", "enabled": True}]
        self.assertEqual(sr.resolve_enabled_stream_destinations(destinations), [])

    def test_tiktok_requires_a_full_url_not_just_a_key(self):
        # TikTok has no fixed ingest preset -- a stream key alone (as would
        # work for Twitch/YouTube/Facebook) must NOT resolve to anything,
        # since there's no preset URL to combine it with.
        destinations = [{"platform": "tiktok", "rtmp_url": "", "stream_key": "some-tiktok-key", "enabled": True}]
        self.assertEqual(sr.resolve_enabled_stream_destinations(destinations), [])

    def test_tiktok_with_full_pasted_url_resolves(self):
        destinations = [{
            "platform": "tiktok", "rtmp_url": "rtmp://tiktok-ingest.example/live/session-specific-path",
            "stream_key": "", "enabled": True,
        }]
        self.assertEqual(
            sr.resolve_enabled_stream_destinations(destinations),
            ["rtmp://tiktok-ingest.example/live/session-specific-path"],
        )

    def test_empty_list_resolves_to_empty(self):
        self.assertEqual(sr.resolve_enabled_stream_destinations([]), [])
        self.assertEqual(sr.resolve_enabled_stream_destinations(None), [])

    def test_order_is_preserved(self):
        destinations = [
            {"platform": "custom", "rtmp_url": "rtmp://b/app", "enabled": True},
            {"platform": "custom", "rtmp_url": "rtmp://a/app", "enabled": True},
        ]
        self.assertEqual(sr.resolve_enabled_stream_destinations(destinations), ["rtmp://b/app", "rtmp://a/app"])


class BuildTeeDestinationSpecTests(unittest.TestCase):
    def test_single_destination(self):
        self.assertEqual(sr.build_tee_destination_spec(["rtmp://a/app"]), "[f=flv]rtmp://a/app")

    def test_multiple_destinations_joined_with_pipe(self):
        spec = sr.build_tee_destination_spec(["rtmp://a/app", "rtmp://b/app"])
        self.assertEqual(spec, "[f=flv]rtmp://a/app|[f=flv]rtmp://b/app")

    def test_empty_returns_none(self):
        self.assertIsNone(sr.build_tee_destination_spec([]))
        self.assertIsNone(sr.build_tee_destination_spec(None))


class BuildFfmpegStreamArgsTests(unittest.TestCase):
    def test_single_destination_argv_shape(self):
        args = sr.build_ffmpeg_stream_args("ffmpeg", ["rtmp://a/app"], framerate=25)
        self.assertEqual(args[0], "ffmpeg")
        self.assertEqual(args[-1], "[f=flv]rtmp://a/app")
        self.assertIn("-map", args)
        self.assertEqual(args[args.index("-map") + 1], "0")
        self.assertIn("pipe:0", args)
        self.assertEqual(args.count("-c:v"), 1, "must be exactly one video encode, not one per destination")
        self.assertEqual(args.count("-c:a"), 1)
        self.assertEqual(args[-2], "tee")

    def test_multi_destination_tee_spec(self):
        urls = ["rtmp://a/app/key1", "rtmp://b/app/key2", "rtmp://c/app/key3"]
        args = sr.build_ffmpeg_stream_args("ffmpeg", urls)
        self.assertEqual(args[-1], "[f=flv]rtmp://a/app/key1|[f=flv]rtmp://b/app/key2|[f=flv]rtmp://c/app/key3")
        # Still exactly one encode even with three destinations.
        self.assertEqual(args.count("-c:v"), 1)

    def test_no_destinations_returns_none(self):
        self.assertIsNone(sr.build_ffmpeg_stream_args("ffmpeg", []))

    def test_bare_string_destination_treated_as_single_element_list(self):
        args = sr.build_ffmpeg_stream_args("ffmpeg", "rtmp://a/app")
        self.assertEqual(args[-1], "[f=flv]rtmp://a/app")

    def test_bitrate_and_framerate_options_applied(self):
        args = sr.build_ffmpeg_stream_args("ffmpeg", ["rtmp://a/app"], framerate=24, video_bitrate_kbps=4000)
        self.assertIn("24", args[args.index("-r") + 1:args.index("-r") + 2])
        self.assertEqual(args[args.index("-b:v") + 1], "4000k")
        self.assertEqual(args[args.index("-g") + 1], "48")  # 2s GOP at 24fps


class PlatformPresetTests(unittest.TestCase):
    def test_fixed_ingest_platforms_have_real_urls(self):
        self.assertTrue(sr.PLATFORM_PRESETS["twitch"]["rtmp_url"].startswith("rtmp://"))
        self.assertTrue(sr.PLATFORM_PRESETS["youtube"]["rtmp_url"].startswith("rtmp://"))
        self.assertTrue(sr.PLATFORM_PRESETS["facebook"]["rtmp_url"].startswith("rtmps://"))

    def test_tiktok_and_custom_have_no_preset_url(self):
        self.assertEqual(sr.PLATFORM_PRESETS["tiktok"]["rtmp_url"], "")
        self.assertEqual(sr.PLATFORM_PRESETS["custom"]["rtmp_url"], "")

    def test_list_platform_presets_includes_id(self):
        presets = sr.list_stream_platform_presets()
        ids = {p["id"] for p in presets}
        self.assertEqual(ids, {"twitch", "youtube", "facebook", "tiktok", "custom"})

    def test_get_unknown_platform_falls_back_to_custom(self):
        self.assertEqual(sr.get_stream_platform_preset("not-a-real-platform"), sr.PLATFORM_PRESETS["custom"])


class ResolveFfmpegPathTests(unittest.TestCase):
    def test_resolves_to_an_existing_executable(self):
        path = sr.resolve_ffmpeg_path()
        self.assertTrue(os.path.isfile(path), "resolved ffmpeg path does not exist: {}".format(path))
        self.assertTrue(os.access(path, os.X_OK), "resolved ffmpeg path is not executable: {}".format(path))


if __name__ == "__main__":
    unittest.main()

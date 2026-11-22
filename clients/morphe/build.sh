#!/usr/bin/env bash
# Builds the HuddleFM patch bundle for Morphe, as Slick Android builds its own:
# the Java extension to a dex, the Kotlin patches to a jar, both in one .mpp.
set -euo pipefail

root="$(dirname "$(realpath "$0")")"
tools="$root/work"
: "${JAVA_HOME:?Set JAVA_HOME to a JDK 21 or newer installation}"
export PATH="$JAVA_HOME/bin:$PATH"
mkdir -p "$tools"

version="${VERSION:-0.0.0-dev}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
	echo "Invalid version: $version" >&2
	exit 1
}
bundle="$root/dist/huddlefm-android-$version.mpp"
android_jar="$tools/platform/android-37.2/android.jar"

download() {
	local sum="$2  $tools/$1"
	sha256sum -c - <<<"$sum" &>/dev/null || curl -fsSL --retry 3 "$3" -o "$tools/$1"
	sha256sum -c - <<<"$sum"
}

# The same tools, at the same versions, as Slick Android's build.
download morphe.jar 855dd2d6fa5ed997a5884a44f8807c9b5bc95e69b5ebd58dfd7e8b897c86e2d7 \
	https://github.com/MorpheApp/morphe-desktop/releases/download/v2.0.0/morphe-desktop-2.0.0-all.jar
download kotlin.zip 7cc140e76daf416a0424a5557f99afd7ca89ebd463ea1101261e3e01c33e75cd \
	https://github.com/JetBrains/kotlin/releases/download/v2.4.21/kotlin-compiler-2.4.21.zip
download r8.jar f8c762ff84640b10083b934a47278758a7665977e618fab0c927fff00521dea3 \
	https://dl.google.com/dl/android/maven2/com/android/tools/r8/9.5.29/r8-9.5.29.jar
download platform.zip 17af98ec1427a1fed9ea278184aba71e53b87eca103655602f9fc64ef11ea4d3 \
	https://dl.google.com/android/repository/platform-37.2_r02.zip
[[ -d "$tools/kotlinc" ]] || unzip -qo "$tools/kotlin.zip" -d "$tools"
[[ -f "$android_jar" ]] || unzip -qo "$tools/platform.zip" -d "$tools/platform"

build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
d8() { java -Xmx512m -cp "$tools/r8.jar" com.android.tools.r8.D8 "$@"; }

# Slack's own classes the extension uses, to compile against. They aren't put
# in the dex: the app has the real ones.
find "$root/stubs" -name '*.java' >"$build/stubs.txt"
javac --release 11 -cp "$android_jar" -d "$build/stubs" @"$build/stubs.txt"

# The extension, to huddlefm-extension.dex, which extendWith() loads into Slack.
printf 'package huddlefm.android;\n\nfinal class Version {\n  static final String NAME = "%s";\n}\n' "$version" >"$build/Version.java"
javac --release 11 -Xlint:-options -cp "$android_jar:$build/stubs" -d "$build/ext" \
	"$root"/extension/huddlefm/android/*.java "$build/Version.java"
jar cf "$build/ext.jar" -C "$build/ext" .
d8 --min-api 32 --lib "$android_jar" --classpath "$build/stubs" --output "$build" "$build/ext.jar"
mv "$build/classes.dex" "$build/huddlefm-extension.dex"

"$tools/kotlinc/bin/kotlinc" -J-Xmx512m -cp "$tools/morphe.jar" -jvm-target 11 -Xlambdas=class \
	"$root"/patches/*.kt -d "$build/patches.jar" 2>&1 | grep -v '^warning' || true
[[ -f "$build/patches.jar" ]]
d8 --min-api 26 --lib "$JAVA_HOME" --classpath "$tools/morphe.jar" --output "$build" "$build/patches.jar"

cat >"$build/about.mf" <<EOF
Name: HuddleFM patches
Description: HuddleFM's controls in Slack huddles on Android
Version: $version
Patcher-Version: 2.2.0
License: AGPL-3.0
Source: https://github.com/ingoau/huddlefm

EOF
jar ufm "$build/patches.jar" "$build/about.mf" -C "$build" classes.dex -C "$build" huddlefm-extension.dex
mkdir -p "$(dirname "$bundle")"
cp "$build/patches.jar" "$bundle"
# patches-list.json describes the bundle for Morphe's index; the release workflow commits it.
"$tools/kotlinc/bin/kotlinc" -J-Xmx512m -cp "$tools/morphe.jar" -jvm-target 11 \
	"$root/scripts/PatchesList.kt" -d "$build/list" 2>&1 | grep -v '^warning' || true
java -cp "$tools/morphe.jar:$build/list" PatchesListKt "$bundle" "$version" "$root/dist/patches-list.json"
java -jar "$tools/morphe.jar" list-patches --patches "$bundle" --with-packages --with-versions 2>/dev/null | grep -v '^INFO'
printf '\nBuilt %s\n' "$bundle"

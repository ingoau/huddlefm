package huddlefm.android

import app.morphe.patcher.patch.Option
import app.morphe.patcher.patch.resourcePatch
import app.morphe.patcher.patch.stringOption
import org.w3c.dom.Element

private const val ANDROID = "http://schemas.android.com/apk/res/android"
private const val SLACK_PACKAGE = "com.Slack"

/**
 * Gives the patched app its own package, so it installs beside Slack from Google Play. Slack builds
 * its providers' authorities from its package name at run time, so only the manifest, and the
 * resources it points to, name the old one: its authorities, its own permission, and shortcuts'
 * target package.
 */
val alongsideSlack =
    resourcePatch(
        name = "Install alongside Slack",
        description = "Gives the patched app its own package name and name, so it installs next to Slack from Google Play.",
        default = false,
    ) {
        compatibleWith(SLACK)

        val packageName by stringOption(
            key = "packageName",
            default = "com.Slack.huddlefm",
            title = "Package name",
            description = "The patched app's package name. It must differ from Slack's.",
            required = true,
            validator = fun Option<String>.(value: String?): Boolean =
                value != null && value != SLACK_PACKAGE && Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$").matches(value),
        )
        val appName by stringOption(
            key = "appName",
            default = "Slack HuddleFM",
            title = "App name",
            description = "The name under the patched app's icon, to tell it from Slack.",
            required = true,
        )

        execute {
            val next = packageName!!
            /** A value naming Slack's package, as it names the patched app's instead. */
            fun renamed(value: String) =
                when {
                    value == SLACK_PACKAGE -> next
                    value.startsWith("$SLACK_PACKAGE.") -> next + value.removePrefix(SLACK_PACKAGE)
                    else -> null
                }

            fun Element.rename(attribute: String) {
                if (!hasAttributeNS(ANDROID, attribute)) return
                renamed(getAttributeNS(ANDROID, attribute))?.let { setAttributeNS(ANDROID, "android:$attribute", it) }
            }

            val xml = mutableSetOf<String>()
            document("AndroidManifest.xml").use { d ->
                val manifest = d.documentElement
                check(manifest.getAttribute("package") == SLACK_PACKAGE) { "Not Slack's manifest" }
                manifest.setAttribute("package", next)
                val all = d.getElementsByTagName("*")
                for (i in 0 until all.length) {
                    val e = all.item(i) as Element
                    when (e.tagName) {
                        "provider" -> {
                            // a provider can serve several authorities, separated by semicolons
                            val authorities = e.getAttributeNS(ANDROID, "authorities")
                            e.setAttributeNS(
                                ANDROID,
                                "android:authorities",
                                authorities.split(';').joinToString(";") { renamed(it) ?: it },
                            )
                        }
                        "permission", "uses-permission", "permission-tree" -> e.rename("name")
                    }
                    e.rename("permission")
                    e.rename("readPermission")
                    e.rename("writePermission")
                    e.getAttributeNS(ANDROID, "resource").takeIf { it.startsWith("@xml/") }?.let { xml += it.removePrefix("@xml/") }
                }
                // the name under the icon and in Recents: everything labelled with app_name
                for (i in 0 until all.length) {
                    val e = all.item(i) as Element
                    if (e.getAttributeNS(ANDROID, "label") == "@string/app_name")
                        e.setAttributeNS(ANDROID, "android:label", "@string/huddlefm_app_name")
                }
            }
            document("res/values/strings.xml").use { d ->
                d.documentElement.appendChild(
                    d.createElement("string").apply {
                        setAttribute("name", "huddlefm_app_name")
                        textContent = appName!!
                    },
                )
            }
            // shortcuts, widgets and file paths: an intent's target package, mostly
            for (name in xml) {
                document("res/xml/$name.xml").use { d ->
                    val all = d.getElementsByTagName("*")
                    for (i in 0 until all.length) {
                        val e = all.item(i) as Element
                        val attributes = e.attributes
                        for (j in 0 until attributes.length) {
                            val a = attributes.item(j)
                            renamed(a.nodeValue)?.let { a.nodeValue = it }
                        }
                    }
                }
            }
        }
    }

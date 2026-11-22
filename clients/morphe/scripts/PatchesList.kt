// Writes patches-list.json for a built bundle, in the shape of Morphe's patches template, so
// Morphe's index and other tools can read what the bundle patches without loading it.
// Usage: java -cp morphe.jar:<this> PatchesListKt <bundle.mpp> <version> <out.json>

import app.morphe.patcher.patch.loadPatchesFromJar
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File

/** Any value the patcher's API hands back, as JSON. */
private fun json(value: Any?): JsonElement =
    when (value) {
        null -> JsonNull
        is JsonElement -> value
        is Boolean -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is String -> JsonPrimitive(value)
        is Enum<*> -> JsonPrimitive(value.name)
        is Map<*, *> -> JsonObject(value.entries.associate { (k, v) -> (if (k is Enum<*>) k.name else k.toString()) to json(v) })
        is Iterable<*> -> JsonArray(value.map(::json))
        is Array<*> -> JsonArray(value.map(::json))
        else -> JsonPrimitive(value.toString())
    }

private fun obj(vararg pairs: Pair<String, Any?>) = JsonObject(pairs.associate { (k, v) -> k to json(v) })

@Suppress("DEPRECATION")
fun main(args: Array<String>) {
    val (bundle, version, out) = args
    val patches = loadPatchesFromJar(setOf(File(bundle))).filter { it.name != null }.sortedBy { it.name }
    val list =
        obj(
            "NOTE" to "Written by the Morphe patch release workflow. Don't edit it: Morphe and other tools read it.",
            "version" to version,
            "patches" to
                patches.map { patch ->
                    obj(
                        "name" to patch.name,
                        "description" to patch.description,
                        "default" to patch.default,
                        "category" to patch.category,
                        "compatiblePackages" to
                            patch.compatibility?.map { c ->
                                obj(
                                    "packageName" to c.packageName,
                                    "name" to c.name,
                                    "description" to c.description,
                                    "apkFileType" to c.apkFileType?.name,
                                    "appIconColor" to c.appIconColor?.let { "#%06X".format(it) },
                                    "signatures" to c.signatures,
                                    "formFactor" to c.formFactor?.name,
                                    "targets" to
                                        c.targets.map { t ->
                                            obj(
                                                "version" to t.version,
                                                "versionCodes" to t.versionCodes,
                                                "isExperimental" to t.isExperimental,
                                                "minSdk" to t.minSdk,
                                                "description" to t.description,
                                            )
                                        },
                                )
                            },
                        "options" to
                            patch.options.values.map { o ->
                                obj(
                                    "key" to o.key,
                                    "title" to o.title,
                                    "description" to o.description,
                                    "required" to o.required,
                                    "type" to o.type.toString(),
                                    "default" to o.default,
                                    "values" to o.values,
                                )
                            },
                    )
                },
        )
    @OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
    val format =
        Json {
            prettyPrint = true
            prettyPrintIndent = "  "
        }
    File(out).writeText(format.encodeToString(JsonObject.serializer(), list) + "\n")
}

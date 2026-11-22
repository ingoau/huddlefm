package huddlefm.android

import app.morphe.patcher.extensions.InstructionExtensions.addInstructions
import app.morphe.patcher.patch.AppTarget
import app.morphe.patcher.patch.BytecodePatchContext
import app.morphe.patcher.patch.Compatibility
import app.morphe.patcher.patch.bytecodePatch
import app.morphe.patcher.util.proxy.mutableTypes.MutableMethod
import com.android.tools.smali.dexlib2.Opcode
import com.android.tools.smali.dexlib2.iface.Method
import com.android.tools.smali.dexlib2.iface.reference.FieldReference
import com.android.tools.smali.dexlib2.iface.instruction.FiveRegisterInstruction
import com.android.tools.smali.dexlib2.iface.instruction.Instruction
import com.android.tools.smali.dexlib2.iface.instruction.ReferenceInstruction
import com.android.tools.smali.dexlib2.iface.instruction.RegisterRangeInstruction
import com.android.tools.smali.dexlib2.iface.reference.MethodReference
import com.android.tools.smali.dexlib2.iface.reference.StringReference
import com.android.tools.smali.dexlib2.iface.reference.TypeReference

// The Slack release Slick Android targets, so the two can be applied together.
internal val SLACK =
    Compatibility(
        name = "Slack",
        packageName = "com.Slack",
        targets = listOf(AppTarget(version = "26.11.30.0")),
    )

private const val EXTENSION = "Lhuddlefm/android"
private const val SESSION = "Lslack/services/huddles/core/impl/meetingsession/ChimeMeetingSessionImpl;"

private val MutableMethod.code get() = implementation!!.instructions
private val Instruction.ref get() = (this as? ReferenceInstruction)?.reference

/** The registers an invoke passes, whichever form it takes. */
private val Instruction.arguments: List<Int>
    get() =
        when (this) {
            is RegisterRangeInstruction -> (startRegister until startRegister + registerCount).toList()
            is FiveRegisterInstruction ->
                listOf(registerC, registerD, registerE, registerF, registerG).take(registerCount)
            else -> error("Not an invoke: $opcode")
        }

private fun BytecodePatchContext.method(
    type: String,
    name: String,
    match: (MutableMethod) -> Boolean = { true },
): MutableMethod =
    checkNotNull(mutableClassDefByOrNull(type)) { "Missing class $type" }.methods.single { it.name == name && match(it) }

/**
 * A method by its class and name if it's there, or else the one method, among every class, that
 * [fingerprint] picks. R8 names generated classes (lambdas, coroutines) differently between builds
 * of the same Slack release, and merges or moves methods, so a name is only a first guess.
 */
private fun BytecodePatchContext.locate(
    what: String,
    type: String,
    name: String,
    fingerprint: (Method) -> Boolean,
): MutableMethod {
    mutableClassDefByOrNull(type)?.methods?.singleOrNull { it.name == name && fingerprint(it) }?.let { return it }
    val found = mutableListOf<Method>()
    classDefForEach { c -> found += c.methods.filter { it.implementation != null && fingerprint(it) } }
    check(found.size == 1) { "Expected one $what, found ${found.size}: ${found.take(5).map { "${it.definingClass}->${it.name}" }}" }
    val m = found.single()
    return mutableClassDefBy(m.definingClass).methods.single {
        it.name == m.name && it.parameterTypes == m.parameterTypes && it.returnType == m.returnType
    }
}

private val Method.instructions get() = implementation?.instructions?.toList().orEmpty()

private fun Method.calls(type: String, name: String) =
    instructions.any { (it.ref as? MethodReference)?.let { r -> r.definingClass == type && r.name == name } == true }

private fun Method.reads(type: String, name: String) =
    instructions.any { (it.ref as? FieldReference)?.let { r -> r.definingClass == type && r.name == name } == true }

private fun Method.hasString(value: String) = instructions.any { (it.ref as? StringReference)?.string == value }

private const val BOTTOM_BAR = "Lslack/features/huddles/ui/bottombar/circuit/HuddleBottomBarScreen;"
private const val COMPOSER = "Landroidx/compose/runtime/GapComposer;"
private const val CLICKED = "Lslack/features/huddles/settings/circuit/HuddleSettingsScreen\$Event\$OnItemClicked;"

/** Where the huddle's column starts the bottom bar: a new HuddleBottomBarScreen just after a node ends. */
private fun barIndex(code: List<Instruction>) =
    code.indices.firstOrNull { i ->
        i > 0 &&
            code[i].opcode == Opcode.NEW_INSTANCE &&
            (code[i].ref as? TypeReference)?.type == BOTTOM_BAR &&
            (code[i - 1].ref as? MethodReference)?.let { it.definingClass == COMPOSER && it.name == "end" } == true
    }

val huddleFM =
    bytecodePatch(
        name = "HuddleFM",
        description = "Adds HuddleFM to huddles: a now playing card above the bottom bar, its controls in More Options, and its song in Android's media controls. Works with or without Slick Android.",
        default = true,
    ) {
        compatibleWith(SLACK)
        extendWith("huddlefm-extension.dex")
        execute {
            // Context is attached by the framework before Application.onCreate.
            method("Lslack/app/SlackApp;", "onCreate") { it.parameterTypes.isEmpty() }
                .addInstructions(0, "invoke-static/range {p0 .. p0}, $EXTENSION/HuddleFM;->init(Landroid/app/Application;)V")

            // The huddle's Chime session tells its own observer when audio has started, with its
            // facade in place: HuddleFM listens on its topic from then. These are the Chime SDK's
            // observer methods, which R8 can't rename.
            method(SESSION, "onAudioSessionStarted") { it.parameterTypes.map(Any::toString) == listOf("Z") }
                .addInstructions(0, "invoke-static/range {p0 .. p0}, $EXTENSION/Channel;->attach(Ljava/lang/Object;)V")
            method(SESSION, "onAudioSessionStopped") { it.parameterTypes.size == 1 }
                .addInstructions(0, "invoke-static/range {p0 .. p0}, $EXTENSION/Channel;->detach(Ljava/lang/Object;)V")
            mutableClassDefByOrNull(SESSION)!!.methods.singleOrNull { it.name == "leaveCall" && it.parameterTypes.isEmpty() }
                ?.addInstructions(0, "invoke-static/range {p0 .. p0}, $EXTENSION/Channel;->detach(Ljava/lang/Object;)V")

            // What invites people to the huddle, and the huddle the user is in, for starting
            // HuddleFM from the panel. Without them it's invited as anyone is, so they're optional.
            mutableClassDefByOrNull("Lslack/services/calls/service/backend/HuddleInviteesManagerImpl;")
                ?.methods?.singleOrNull { it.name == "<init>" }
                ?.run {
                    val end = code.indexOfLast { it.opcode == Opcode.RETURN_VOID }
                    addInstructions(end, "invoke-static/range {p0 .. p0}, $EXTENSION/Invite;->manager(Ljava/lang/Object;)V")
                }
            mutableClassDefByOrNull("Lslack/services/huddles/managers/api/models/HuddleState\$Active;")
                ?.methods?.singleOrNull { it.name == "<init>" }
                ?.run {
                    val end = code.indexOfLast { it.opcode == Opcode.RETURN_VOID }
                    addInstructions(end, "invoke-static/range {p0 .. p0}, $EXTENSION/Channel;->huddle(Ljava/lang/Object;)V")
                }

            // The huddle is a column: its header, the tiles (with Slack's banners floating over their
            // foot), then the bottom bar. HuddleFM's card goes between the tiles and the bar, so the
            // tiles make room for it rather than being covered. It's drawn with Compose's
            // AndroidView, so without that, there's no card and the rest still works.
            if (mutableClassDefByOrNull("Landroidx/compose/ui/viewinterop/AndroidView_androidKt;")?.methods?.any { it.name == "AndroidView" } == true) {
                locate("huddle layout", "Lslack/features/huddles/gallery/circuit/HuddleGalleryUiKt;", "HeaderBannerGrid") { m ->
                    // the bar that comes after a node ends, not the thread's or the sheet's
                    barIndex(m.instructions) != null && m.instructions.any { i -> (i.ref as? MethodReference)?.parameterTypes?.firstOrNull()?.toString() == "Lslack/features/huddles/gallery/circuit/HuddleGalleryScreen\$State;" }
                }.run {
                    val bar = checkNotNull(barIndex(code)) { "Huddle bottom bar moved" }
                    // the tiles' box ends just before, on the composer
                    val composer = code[bar - 1].arguments[0]
                    addInstructions(bar, "invoke-static/range {v$composer .. v$composer}, $EXTENSION/Bar;->card(Ljava/lang/Object;)V")
                }
            }

            // The huddle's More Options: HuddleFM's row goes after Slack's own Play music.
            locate("More Options list", "Lslack/features/huddles/settings/utils/HuddleSettingsDataUseCaseImpl;", "getMoreOptionsSection") { m ->
                m.name != "<clinit>" && m.hasString("id_jukebox_options") && m.calls("Ljava/util/List;", "add")
            }.run {
                val music = code.indexOfFirst { (it.ref as? StringReference)?.string == "id_jukebox_options" }
                val add =
                    (music until code.size).first { i ->
                        (code[i].ref as? MethodReference)?.let { it.definingClass == "Ljava/util/List;" && it.name == "add" && it.parameterTypes.size == 1 } == true
                    }
                // add(list, Play music's row), which HuddleFM's is made like
                val (list, row) = code[add].arguments
                check(list < 16 && row < 16) { "More Options list moved to high registers" }
                val next = if (code[add + 1].opcode == Opcode.MOVE_RESULT) add + 2 else add + 1
                addInstructions(next, "invoke-static {v$list, v$row}, $EXTENSION/Menu;->add(Ljava/util/List;Ljava/lang/Object;)V")
            }

            // A click on a More Options row: HuddleFM's opens its controls, the rest go on to Slack.
            // The coroutine that handles it is generated, so it's found by the click it reads.
            locate("More Options click handler", "Lslack/features/huddles/settings/circuit/HuddleSettingsPresenter\$present\$2\$1\$1;", "invokeSuspend") { m ->
                m.name == "invokeSuspend" && m.definingClass != CLICKED && m.reads(CLICKED, "itemId")
            }.addInstructions(
                0,
                """
                invoke-static/range {p0 .. p0}, $EXTENSION/Menu;->click(Ljava/lang/Object;)Z
                move-result v0
                if-eqz v0, :slack
                sget-object v0, Lkotlin/Unit;->INSTANCE:Lkotlin/Unit;
                return-object v0
                :slack
                nop
                """,
            )
        }
    }

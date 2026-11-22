package huddlefm.android

import app.morphe.patcher.extensions.InstructionExtensions.addInstructions
import app.morphe.patcher.patch.AppTarget
import app.morphe.patcher.patch.BytecodePatchContext
import app.morphe.patcher.patch.Compatibility
import app.morphe.patcher.patch.bytecodePatch
import app.morphe.patcher.util.proxy.mutableTypes.MutableMethod
import com.android.tools.smali.dexlib2.Opcode
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

            // Slack listens on its own topic once the huddle's audio has started, with the
            // session's Chime facade in place: HuddleFM listens on its topic then too.
            method("Lslack/services/huddles/core/impl/meetingsession/ChimeMeetingSessionImpl\$addMonitoringForDataMessages\$observer\$1;", "<init>")
                .run {
                    check(parameterTypes.single().toString() == SESSION) { "Data message observer changed" }
                    val end = code.indexOfLast { it.opcode == Opcode.RETURN_VOID }
                    addInstructions(end, "invoke-static/range {p1 .. p1}, $EXTENSION/Channel;->attach(Ljava/lang/Object;)V")
                }
            method(SESSION, "leaveCall") { it.parameterTypes.isEmpty() }
                .addInstructions(0, "invoke-static/range {p0 .. p0}, $EXTENSION/Channel;->detach(Ljava/lang/Object;)V")

            // What invites people to the huddle, for starting HuddleFM from the panel.
            method("Lslack/services/calls/service/backend/HuddleInviteesManagerImpl;", "<init>").run {
                val end = code.indexOfLast { it.opcode == Opcode.RETURN_VOID }
                addInstructions(end, "invoke-static/range {p0 .. p0}, $EXTENSION/Invite;->manager(Ljava/lang/Object;)V")
            }

            // The huddle the user is in, for inviting HuddleFM to it.
            method("Lslack/services/huddles/managers/api/models/HuddleState\$Active;", "<init>").run {
                val end = code.indexOfLast { it.opcode == Opcode.RETURN_VOID }
                addInstructions(end, "invoke-static/range {p0 .. p0}, $EXTENSION/Channel;->huddle(Ljava/lang/Object;)V")
            }

            // The huddle is a column: its header, the tiles (with Slack's banners floating over their
            // foot), then the bottom bar. HuddleFM's card goes between the tiles and the bar, so the
            // tiles make room for it rather than being covered.
            method("Lslack/features/huddles/gallery/circuit/HuddleGalleryUiKt;", "HeaderBannerGrid").run {
                val bar =
                    code.indexOfFirst {
                        it.opcode == Opcode.NEW_INSTANCE && (it.ref as? TypeReference)?.type == "Lslack/features/huddles/ui/bottombar/circuit/HuddleBottomBarScreen;"
                    }
                check(bar > 0) { "Huddle bottom bar moved" }
                // the tiles' box ends just before, on the composer
                val box = code[bar - 1]
                check((box.ref as? MethodReference)?.let { it.definingClass == "Landroidx/compose/runtime/GapComposer;" && it.name == "end" } == true) {
                    "Huddle layout changed"
                }
                val composer = box.arguments[0]
                addInstructions(bar, "invoke-static/range {v$composer .. v$composer}, $EXTENSION/Bar;->card(Ljava/lang/Object;)V")
            }

            // The huddle's More Options: HuddleFM's row goes after Slack's own Play music.
            method("Lslack/features/huddles/settings/utils/HuddleSettingsDataUseCaseImpl;", "getMoreOptionsSection").run {
                val music = code.indexOfFirst { (it.ref as? StringReference)?.string == "id_jukebox_options" }
                check(music >= 0) { "Play music option moved" }
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
            method("Lslack/features/huddles/settings/circuit/HuddleSettingsPresenter\$present\$2\$1\$1;", "invokeSuspend").addInstructions(
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

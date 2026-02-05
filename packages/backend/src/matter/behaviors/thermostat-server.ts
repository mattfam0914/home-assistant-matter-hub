// FILE: packages/backend/src/matter/behaviors/thermostat-server.ts

import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { ThermostatServer as Base } from "@matter/main/behaviors";
import { Thermostat } from "@matter/main/clusters";
import type { HomeAssistantAction } from "../../services/home-assistant/home-assistant-actions.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { Temperature } from "../../utils/converters/temperature.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

import SystemMode = Thermostat.SystemMode;
import RunningMode = Thermostat.ThermostatRunningMode;

import type { ActionContext } from "@matter/main";
import { transactionIsOffline } from "../../utils/transaction-is-offline.js";

const FeaturedBase = Base.with("Heating", "Cooling", "AutoMode");

export interface ThermostatRunningState {
  heat: boolean;
  cool: boolean;
  fan: boolean;
  heatStage2: false;
  coolStage2: false;
  fanStage2: false;
  fanStage3: false;
}

export interface ThermostatServerConfig {
  supportsTemperatureRange: ValueGetter<boolean>;
  getMinTemperature: ValueGetter<Temperature | undefined>;
  getMaxTemperature: ValueGetter<Temperature | undefined>;
  getCurrentTemperature: ValueGetter<Temperature | undefined>;
  getTargetHeatingTemperature: ValueGetter<Temperature | undefined>;
  getTargetCoolingTemperature: ValueGetter<Temperature | undefined>;

  getSystemMode: ValueGetter<SystemMode>;
  getRunningMode: ValueGetter<RunningMode>;

  setSystemMode: ValueSetter<SystemMode>;
  setTargetTemperature: ValueSetter<Temperature>;
  setTargetTemperatureRange: ValueSetter<{
    low: Temperature;
    high: Temperature;
  }>;
}

export class ThermostatServerBase extends FeaturedBase {
  declare state: ThermostatServerBase.State;

  override async initialize() {
    this.state.controlSequenceOfOperation =
      this.features.cooling && this.features.heating
        ? Thermostat.ControlSequenceOfOperation.CoolingAndHeating
        : this.features.cooling
          ? Thermostat.ControlSequenceOfOperation.CoolingOnly
          : Thermostat.ControlSequenceOfOperation.HeatingOnly;

    await super.initialize();

    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);

    this.reactTo(this.events.systemMode$Changed, this.systemModeChanged);
    if (this.features.cooling) {
      this.reactTo(
        this.events.occupiedCoolingSetpoint$Changed,
        this.coolingSetpointChanged,
      );
    }
    if (this.features.heating) {
      this.reactTo(
        this.events.occupiedHeatingSetpoint$Changed,
        this.heatingSetpointChanged,
      );
    }
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update = (entity: HomeAssistantEntityInformation) => {
    const config = this.state.config;

    // Matter Thermostat units are 0.01°C
    const haMin = config.getMinTemperature(entity.state, this.agent)?.celsius(true);
    const haMax = config.getMaxTemperature(entity.state, this.agent)?.celsius(true);

    const localTemperature = config
      .getCurrentTemperature(entity.state, this.agent)
      ?.celsius(true);

    const targetHeatingTemperature =
      config
        .getTargetHeatingTemperature(entity.state, this.agent)
        ?.celsius(true) ?? this.state.occupiedHeatingSetpoint;

    // FIX: this previously called getTargetHeatingTemperature by mistake
    const targetCoolingTemperature =
      config
        .getTargetCoolingTemperature(entity.state, this.agent)
        ?.celsius(true) ?? this.state.occupiedCoolingSetpoint;

    const systemMode = this.getSystemMode(entity);
    const runningMode = config.getRunningMode(entity.state, this.agent);

    // Matter enforces a deadband when AutoMode (Heat+Cool/Range) is supported.
    // Deadband units are 0.01°C (200 = 2.00°C).
    const deadband =
      this.features.autoMode && this.features.heating && this.features.cooling ? 200 : 0;

    // Start with HA's min/max (if present)
    let minHeat = haMin;
    let maxHeat = haMax;
    let minCool = haMin;
    let maxCool = haMax;

    // If we have both heating & cooling + deadband, make the limits Matter-compliant:
    // minHeat <= minCool - deadband
    // maxHeat <= maxCool - deadband
    if (this.features.heating && this.features.cooling && deadband > 0) {
      if (minHeat != null && minCool != null) {
        minCool = Math.max(minCool, minHeat + deadband);
      }
      if (maxHeat != null && maxCool != null) {
        maxHeat = Math.min(maxHeat, maxCool - deadband);
      }
    }

    // Ensure ranges remain valid if HA reports a narrow range
    if (minHeat != null && maxHeat != null && maxHeat < minHeat) {
      maxHeat = minHeat;
    }
    if (minCool != null && maxCool != null && maxCool < minCool) {
      maxCool = minCool;
    }

    // Clamp setpoints so they never violate deadband during endpoint init
    let heatSp = targetHeatingTemperature;
    let coolSp = targetCoolingTemperature;

    if (this.features.heating && this.features.cooling && deadband > 0) {
      if (heatSp != null && coolSp != null && heatSp > coolSp - deadband) {
        // Prefer keeping heat as-is and pushing cool up to satisfy deadband
        coolSp = heatSp + deadband;
      }

      // Respect max limits if we have them; then re-assert relationship
      if (maxCool != null && coolSp != null) {
        coolSp = Math.min(coolSp, maxCool);
      }
      if (coolSp != null && heatSp != null && heatSp > coolSp - deadband) {
        heatSp = coolSp - deadband;
      }

      // Finally respect mins
      if (minHeat != null && heatSp != null) {
        heatSp = Math.max(heatSp, minHeat);
      }
      if (minCool != null && coolSp != null) {
        coolSp = Math.max(coolSp, minCool);
      }
    }

    applyPatchState(this.state, {
      localTemperature: localTemperature,
      systemMode: systemMode,
      thermostatRunningState: this.getRunningState(systemMode, runningMode),

      ...(this.features.heating
        ? {
            occupiedHeatingSetpoint: heatSp,
            minHeatSetpointLimit: minHeat,
            maxHeatSetpointLimit: maxHeat,
            absMinHeatSetpointLimit: minHeat,
            absMaxHeatSetpointLimit: maxHeat,
          }
        : {}),

      ...(this.features.cooling
        ? {
            occupiedCoolingSetpoint: coolSp,
            minCoolSetpointLimit: minCool,
            maxCoolSetpointLimit: maxCool,
            absMinCoolSetpointLimit: minCool,
            absMaxCoolSetpointLimit: maxCool,
          }
        : {}),

      ...(this.features.autoMode
        ? {
            // Use the same deadband we enforce above so Matter doesn't “surprise” us later
            minSetpointDeadBand: deadband,
            thermostatRunningMode: runningMode,
          }
        : {}),
    });
  };

  override setpointRaiseLower(request: Thermostat.SetpointRaiseLowerRequest) {
    const config = this.state.config;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const state = homeAssistant.entity.state;

    let cool = config.getTargetCoolingTemperature(state, this.agent);
    let heat = config.getTargetHeatingTemperature(state, this.agent);

    if (!heat && !cool) {
      return;
    }
    heat = (heat ?? cool)!;
    cool = (cool ?? heat)!;

    const adjustedCool =
      request.mode !== Thermostat.SetpointRaiseLowerMode.Heat
        ? cool.plus(request.amount / 1000, "°C")
        : cool;
    const adjustedHeat =
      request.mode !== Thermostat.SetpointRaiseLowerMode.Cool
        ? heat.plus(request.amount / 1000, "°C")
        : heat;
    this.setTemperature(adjustedHeat, adjustedCool, request.mode);
  }

  private heatingSetpointChanged(
    value: number,
    _oldValue: number,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    const next = Temperature.celsius(value / 100);
    if (!next) {
      return;
    }
    this.setTemperature(
      next,
      Temperature.celsius(this.state.occupiedCoolingSetpoint / 100)!,
      Thermostat.SetpointRaiseLowerMode.Heat,
    );
  }

  private coolingSetpointChanged(
    value: number,
    _oldValue: number,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    const next = Temperature.celsius(value / 100);
    if (!next) {
      return;
    }
    this.setTemperature(
      Temperature.celsius(this.state.occupiedHeatingSetpoint / 100)!,
      next,
      Thermostat.SetpointRaiseLowerMode.Cool,
    );
  }

  private setTemperature(
    low: Temperature,
    high: Temperature,
    mode: Thermostat.SetpointRaiseLowerMode,
  ) {
    const config = this.state.config;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);

    const supportsTemperatureRange = config.supportsTemperatureRange(
      homeAssistant.entity.state,
      this.agent,
    );

    let action: HomeAssistantAction;
    if (supportsTemperatureRange) {
      action = config.setTargetTemperatureRange({ low, high }, this.agent);
    } else {
      const both = mode === Thermostat.SetpointRaiseLowerMode.Heat ? low : high;
      action = config.setTargetTemperature(both, this.agent);
    }
    homeAssistant.callAction(action);
  }

  private systemModeChanged(
    systemMode: Thermostat.SystemMode,
    _oldValue: Thermostat.SystemMode,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction(
      this.state.config.setSystemMode(systemMode, this.agent),
    );
  }

  private getSystemMode(entity: HomeAssistantEntityInformation) {
    let systemMode = this.state.config.getSystemMode(entity.state, this.agent);
    if (systemMode === Thermostat.SystemMode.Auto) {
      systemMode = this.features.autoMode
        ? SystemMode.Auto
        : this.features.heating
          ? SystemMode.Heat
          : this.features.cooling
            ? SystemMode.Cool
            : SystemMode.Sleep;
    }
    return systemMode;
  }

  private getRunningState(
    systemMode: SystemMode,
    runningMode: RunningMode,
  ): ThermostatRunningState {
    const allOff: ThermostatRunningState = {
      cool: false,
      fan: false,
      heat: false,
      heatStage2: false,
      coolStage2: false,
      fanStage2: false,
      fanStage3: false,
    };
    const heat = { ...allOff, heat: true };
    const cool = { ...allOff, cool: true };
    const dry = { ...allOff, heat: true, fan: true };
    const fanOnly = { ...allOff, fan: true };
    switch (systemMode) {
      case SystemMode.Heat:
      case SystemMode.EmergencyHeat:
        return heat;
      case SystemMode.Cool:
      case SystemMode.Precooling:
        return cool;
      case SystemMode.Dry:
        return dry;
      case SystemMode.FanOnly:
        return fanOnly;
      case SystemMode.Off:
      case SystemMode.Sleep:
        return allOff;
      case SystemMode.Auto:
        switch (runningMode) {
          case RunningMode.Heat:
            return heat;
          case RunningMode.Cool:
            return cool;
          case RunningMode.Off:
            return allOff;
        }
    }
  }
}

export namespace ThermostatServerBase {
  export class State extends FeaturedBase.State {
    config!: ThermostatServerConfig;
  }
}

export function ThermostatServer(config: ThermostatServerConfig) {
  return ThermostatServerBase.set({ config });
}
